import type { ImapFlow, MessageStructureObject } from "imapflow";
import { viewOf } from "./bytes";
import { MAX_QUOTE_CHARS, joinQuote, planForward, planReply, splitQuote, type OriginalMessage } from "./compose";
import { ToolError, errorMessage, noMessage } from "./errors";
import { Folders } from "./folders";
import { classifyParts, extractBodyText, withMailbox, type Creds } from "./imap";
import {
  BODY_LENGTH_HEADER,
  assertRecipientLimit,
  MARKER_HEADER,
  MARKER_VALUE,
  buildMessage,
  decodeOwnQuotedPrintable,
  displayAddress,
  parseAddress,
  parseAddressHeader,
  parseAddresses,
  parseHeaders,
  parseMessageIds,
  tryAddress,
  type Address,
} from "./mime";

declare const draftBrand: unique symbol;
declare const ownDraftBrand: unique symbol;

const MAX_DRAFT_BYTES = 15 * 1024 * 1024;

export interface Draft {
  readonly [draftBrand]: true;
  readonly uid: number;
  readonly uidValidity: bigint;
  readonly raw: Uint8Array;
  readonly flags: ReadonlySet<string>;
  readonly authoredHere: boolean;
}

export type OwnDraft = Draft & { readonly [ownDraftBrand]: true };

const forgeBrand = <T extends Draft>(fields: object): T => fields as unknown as T;

export const ownDraft = (draft: Draft): OwnDraft | null => (draft.authoredHere ? forgeBrand<OwnDraft>(draft) : null);

const tooBigDraft = (uid: number) => new ToolError(`Draft ${uid} is larger than ${MAX_DRAFT_BYTES / 1024 / 1024} MB.`);

const noDraft = (uid: number) =>
  new ToolError(`No draft with uid ${uid} in Drafts. uids change on every save_draft. Run search_messages with folder "drafts" to find it.`);

/** Pass readOnly:false when the caller will write to Drafts next, so the same SELECT serves both. */
export async function loadDraft(c: ImapFlow, folders: Folders, uid: number, { readOnly = true } = {}): Promise<Draft> {
  return withMailbox(c, folders.path("drafts"), { readOnly }, async () => {
    const mb = c.mailbox;
    if (!mb) throw new Error("Drafts folder was not selected");
    const meta = await c.fetchOne(String(uid), { uid: true, flags: true, size: true }, { uid: true });
    if (!meta) throw noDraft(uid);
    if (!meta.flags?.has("\\Draft")) throw new ToolError(`Message ${uid} in Drafts is not flagged as a draft, so it cannot be used here.`);
    if ((meta.size ?? 0) > MAX_DRAFT_BYTES) throw tooBigDraft(uid);
    const m = await c.fetchOne(String(uid), { uid: true, source: { maxLength: MAX_DRAFT_BYTES + 1 } }, { uid: true });
    if (!m || !m.source) throw noDraft(uid);
    const raw = viewOf(m.source);
    if (raw.length > MAX_DRAFT_BYTES) throw tooBigDraft(uid);
    return forgeBrand({
      uid,
      uidValidity: mb.uidValidity,
      raw,
      flags: meta.flags,
      authoredHere: parseHeaders(raw).decoded(MARKER_HEADER)?.toLowerCase() === MARKER_VALUE,
    });
  });
}

/** Loads a draft this server created, read-write because every caller changes Drafts next. */
async function loadOwnDraft(c: ImapFlow, folders: Folders, uid: number, cannot: string): Promise<OwnDraft> {
  const own = ownDraft(await loadDraft(c, folders, uid, { readOnly: false }));
  if (!own) throw new ToolError(`Draft ${uid} was not created by this server (for example it was written in Apple Mail), so it cannot be ${cannot}`);
  return own;
}

export async function expungeDraft(c: ImapFlow, folders: Folders, draft: OwnDraft): Promise<void> {
  // Without UIDPLUS, imapflow's messageDelete issues plain EXPUNGE, purging every \Deleted message in the folder.
  if (!c.capabilities.get("UIDPLUS")) {
    throw new ToolError("This mail server does not support UID EXPUNGE, so drafts cannot be deleted safely.");
  }
  await withMailbox(c, folders.path("drafts"), {}, async () => {
    if (c.mailbox && c.mailbox.uidValidity !== draft.uidValidity) {
      throw new ToolError("The server renumbered the Drafts folder. Run search_messages again.");
    }
    if (!(await c.messageDelete(String(draft.uid), { uid: true }))) {
      throw new ToolError(`Could not remove draft ${draft.uid} from Drafts.`);
    }
  });
}

interface DraftFields {
  to?: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject?: string;
  body?: string;
}

export type SaveDraftRequest =
  | {
      mode: "create";
      fields: DraftFields;
      origin: { kind: "new" } | { kind: "reply" | "replyAll" | "forward"; folder: string; uid: number };
      quote: boolean;
    }
  | { mode: "update"; replaceUid: number; fields: DraftFields; quote?: boolean };

interface DraftView {
  uid: number;
  replacedUid: number | null;
  messageId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  quotedOriginal: string | null;
  inReplyTo: string | null;
  notes: string[];
}

const fmt = (l: readonly Address[]) => l.map(displayAddress);

const toAddressesDroppingInvalid = (list: ReadonlyArray<{ name?: string | undefined; address?: string | undefined }> | undefined): Address[] =>
  (list ?? []).flatMap((a) => tryAddress(a) ?? []);

async function loadOriginal(c: ImapFlow, folders: Folders, folderInput: string, uid: number): Promise<OriginalMessage> {
  return withMailbox(c, folders.resolve(folderInput), { readOnly: true }, async () => {
    const m = await c.fetchOne(
      String(uid),
      { uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: ["references"] },
      { uid: true },
    );
    if (!m || !m.envelope || !m.bodyStructure) {
      throw new ToolError(`No message with uid ${uid} in ${folderInput} to reply to or forward. Run search_messages again.`);
    }
    const e = m.envelope;
    const { text, truncated } = await extractBodyText(c, uid, classifyParts(m.bodyStructure as MessageStructureObject), MAX_QUOTE_CHARS);
    const date = m.internalDate ?? e.date;
    return {
      messageId: e.messageId ?? null,
      references: m.headers ? parseMessageIds(parseHeaders(viewOf(m.headers)).decoded("references")) : [],
      from: toAddressesDroppingInvalid(e.from),
      replyTo: toAddressesDroppingInvalid(e.replyTo),
      to: toAddressesDroppingInvalid(e.to),
      cc: toAddressesDroppingInvalid(e.cc),
      subject: e.subject ?? "",
      date: date ? new Date(date) : null,
      bodyText: text,
      bodyTruncated: truncated,
    };
  });
}

const newMessageId = (from: string) => `<${crypto.randomUUID()}@${from.slice(from.indexOf("@") + 1)}>`;

interface DraftBase {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  body: string;
  quoted: string | null;
  inReplyTo: string | undefined;
  references: readonly string[];
}

async function baseForCreate(
  c: ImapFlow,
  folders: Folders,
  self: Address,
  req: Extract<SaveDraftRequest, { mode: "create" }>,
  notes: string[],
): Promise<DraftBase> {
  const empty: DraftBase = { to: [], cc: [], bcc: [], subject: "", body: "", quoted: null, inReplyTo: undefined, references: [] };
  if (req.origin.kind === "new") return empty;
  const o = await loadOriginal(c, folders, req.origin.folder, req.origin.uid);
  const plan =
    req.origin.kind === "forward"
      ? planForward(o, { quote: req.quote })
      : planReply(o, { all: req.origin.kind === "replyAll", self, quote: req.quote });
  if (req.origin.kind === "forward") notes.push("Attachments of the original are not forwarded.");
  if (!o.messageId && req.origin.kind !== "forward") notes.push("The original has no Message-ID, so this reply is not threaded.");
  return {
    ...empty,
    to: [...plan.to],
    cc: [...plan.cc],
    subject: plan.subject,
    quoted: plan.quoted || null,
    inReplyTo: plan.inReplyTo,
    references: plan.references,
  };
}

function baseForUpdate(old: OwnDraft, quote: boolean | undefined): DraftBase {
  const h = parseHeaders(old.raw);
  const stored = h.decoded(BODY_LENGTH_HEADER) ?? "";
  const split = splitQuote(decodeOwnQuotedPrintable(old.raw.subarray(h.bodyOffset)), /^\d+$/.test(stored) ? Number(stored) : null);
  return {
    to: parseAddressHeader(h.undecoded("to")),
    cc: parseAddressHeader(h.undecoded("cc")),
    bcc: parseAddressHeader(h.undecoded("bcc")),
    subject: h.decoded("subject") ?? "",
    body: split.body,
    quoted: quote === false ? null : split.quoted,
    inReplyTo: h.decoded("in-reply-to") || undefined,
    references: parseMessageIds(h.decoded("references")),
  };
}

export async function saveDraft(c: ImapFlow, account: Creds, req: SaveDraftRequest): Promise<DraftView> {
  const self = parseAddress(account.user);
  const folders = await Folders.load(c);
  const notes: string[] = [];

  let old: OwnDraft | null = null;
  let base: DraftBase;
  if (req.mode === "update") {
    old = await loadOwnDraft(c, folders, req.replaceUid, "edited here. Create a new draft instead.");
    base = baseForUpdate(old, req.quote);
  } else {
    base = await baseForCreate(c, folders, self, req, notes);
  }

  const f = req.fields;
  const { to, cc, bcc, subject, body, quoted, inReplyTo, references } = {
    ...base,
    to: f.to ? parseAddresses(f.to) : base.to,
    cc: f.cc ? parseAddresses(f.cc) : base.cc,
    bcc: f.bcc ? parseAddresses(f.bcc) : base.bcc,
    subject: f.subject ?? base.subject,
    body: (f.body ?? base.body).replace(/\r\n?/g, "\n"),
  };
  assertRecipientLimit(to.length + cc.length + bcc.length);

  const messageId = newMessageId(self.address);
  const bytes = buildMessage({
    from: self,
    to,
    cc,
    bcc,
    subject,
    text: joinQuote(body, quoted),
    bodyLength: quoted ? body.length : undefined,
    inReplyTo,
    references,
    messageId,
    date: new Date(),
  });

  const appended = await c.append(folders.path("drafts"), bytes, ["\\Draft", "\\Seen"]);
  if (!appended || appended.uid === undefined) {
    throw new ToolError("The draft was saved, but the server did not report its uid. Run search_messages with folder \"drafts\" to find it.");
  }

  if (old) {
    try {
      await expungeDraft(c, folders, old);
    } catch (e) {
      notes.push(`The previous version (uid ${old.uid}) could not be removed and is still in Drafts: ${errorMessage(e)}`);
    }
  }

  return {
    uid: appended.uid,
    replacedUid: old?.uid ?? null,
    messageId,
    from: displayAddress(self),
    to: fmt(to),
    cc: fmt(cc),
    bcc: fmt(bcc),
    subject,
    body,
    quotedOriginal: quoted,
    inReplyTo: inReplyTo ?? null,
    notes,
  };
}

export async function deleteDraft(c: ImapFlow, uid: number): Promise<{ deleted: true; subject: string }> {
  const folders = await Folders.load(c);
  const draft = await loadOwnDraft(c, folders, uid, "deleted here. Delete it in Apple Mail.");
  const subject = parseHeaders(draft.raw).decoded("subject") ?? "";
  await expungeDraft(c, folders, draft);
  return { deleted: true, subject };
}
