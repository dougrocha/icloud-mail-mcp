import type { ImapFlow } from "imapflow";
import { Buffer } from "node:buffer";
import { concatBytes } from "./bytes";
import { ToolError, errorMessage } from "./errors";
import { expungeDraft, loadDraft, ownDraft, type Draft } from "./drafts";
import { Folders } from "./folders";
import { withMailbox, type Creds } from "./imap";
import { assertRecipientLimit, parseAddress, parseAddressHeader, parseHeaders, prepareForDelivery } from "./mime";
import { sendRaw } from "./smtp";

/** Set before SMTP DATA. On a draft whose Message-ID is not in Sent, it means an earlier attempt stopped partway. */
const SENDING_KEYWORD = "$MCPSending";
const SENT_APPEND_ATTEMPTS = 2;

interface SendReceipt extends AfterSend {
  status: "sent" | "already-sent";
  messageId: string;
  to: string[];
  cc: string[];
  bccCount: number;
}

export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

const hex = (buf: ArrayBuffer) => Buffer.from(buf).toString("hex");

async function fallbackId(uidValidity: bigint, uid: number, raw: Uint8Array, domain: string): Promise<string> {
  const head = new TextEncoder().encode(`${uidValidity}:${uid}:`);
  const rawDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return `<${hex(await crypto.subtle.digest("SHA-256", concatBytes(head, rawDigest))).slice(0, 32)}@${domain}>`;
}

async function findInSent(c: ImapFlow, sentPath: string, messageId: string): Promise<number[]> {
  return withMailbox(c, sentPath, { readOnly: true }, async () => (await c.search({ header: { "message-id": messageId } }, { uid: true })) || []);
}

async function appendToSent(c: ImapFlow, sentPath: string, wire: Uint8Array): Promise<{ ok: boolean; uid: number | null }> {
  for (let attempt = 0; attempt < SENT_APPEND_ATTEMPTS; attempt++) {
    try {
      const r = await c.append(sentPath, wire, ["\\Seen"]);
      if (r) return { ok: true, uid: r.uid ?? null };
    } catch {}
  }
  return { ok: false, uid: null };
}

/** Returns whether the keyword is now on the draft, read back from the server. Never throws. */
async function setKeyword(c: ImapFlow, draftsPath: string, uid: number, keyword: string): Promise<boolean> {
  try {
    return await withMailbox(c, draftsPath, {}, async () => {
      await c.messageFlagsAdd(String(uid), [keyword], { uid: true });
      const m = await c.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
      return !!m && !!m.flags?.has(keyword);
    });
  } catch {
    return false;
  }
}

async function clearKeyword(c: ImapFlow, draftsPath: string, uid: number, keyword: string): Promise<void> {
  await withMailbox(c, draftsPath, {}, () => c.messageFlagsRemove(String(uid), [keyword], { uid: true })).catch(() => {});
}

/**
 * Sends over SMTP. SENDING_KEYWORD goes on the draft first, so a request cut off after the server
 * accepted the message still leaves a trace that stops a retry.
 */
async function deliverOnce(
  c: ImapFlow,
  account: Creds,
  limiter: RateLimiter,
  draftsPath: string,
  draft: Draft,
  wire: Uint8Array,
  recipients: readonly string[],
): Promise<void> {
  if (!(await limiter.limit({ key: `send:${account.user}` })).success) {
    throw new ToolError("Too many sends in a short time. Nothing was sent. Wait a minute and try again.");
  }
  if (!(await setKeyword(c, draftsPath, draft.uid, SENDING_KEYWORD))) {
    throw new ToolError("Nothing was sent. The server would not record the send attempt on the draft, and that record is what prevents sending twice.");
  }
  const out = await sendRaw(account, { from: account.user, recipients }, wire);
  if (out.kind === "rejected") {
    await clearKeyword(c, draftsPath, draft.uid, SENDING_KEYWORD);
    throw new ToolError(
      `NOT sent. The mail server refused it at the ${out.stage} step${out.code ? ` with code ${out.code}` : ""} and replied "${out.reply}". The draft is untouched, and it is safe to try again.`,
    );
  }
  if (out.kind === "unknown") {
    throw new ToolError(
      `The send may or may not have happened (${out.reason}). Do NOT retry. Check the Sent folder or ask a recipient first. The draft was left in Drafts.`,
    );
  }
}

interface AfterSend {
  sentCopy: "filed" | "failed";
  sentUid: number | null;
  draftRemoved: boolean;
  note?: string;
}

/**
 * Runs once the message is known to be delivered, so it never throws: an error here would read as
 * "not sent" and invite a retry.
 */
async function finalizeAfterSend(
  c: ImapFlow,
  folders: Folders,
  draft: Draft,
  record: () => Uint8Array,
  sentUids: readonly number[],
): Promise<AfterSend> {
  try {
    const filed = sentUids.length > 0 ? { ok: true, uid: sentUids[0]! } : await appendToSent(c, folders.path("sent"), record());
    if (!filed.ok) {
      return {
        sentCopy: "failed",
        sentUid: null,
        draftRemoved: false,
        note: "The email was delivered, but filing a copy in Sent failed. Do not call send_draft on it again. It will refuse rather than send twice. Delete the draft in Apple Mail.",
      };
    }
    const done = { sentCopy: "filed" as const, sentUid: filed.uid };
    const own = ownDraft(draft);
    if (!own) return { ...done, draftRemoved: false, note: "This server did not write the draft, so it stays in Drafts for you to delete." };
    try {
      await expungeDraft(c, folders, own);
      return { ...done, draftRemoved: true };
    } catch (e) {
      return { ...done, draftRemoved: false, note: `Sent and filed, but the draft could not be removed from Drafts: ${errorMessage(e)}` };
    }
  } catch (e) {
    return {
      sentCopy: "failed",
      sentUid: null,
      draftRemoved: false,
      note: `The email WAS sent, but a later step failed (${errorMessage(e)}). Do NOT call send_draft again. Check the Sent folder and delete the draft yourself.`,
    };
  }
}

export async function sendDraft(
  c: ImapFlow,
  account: Creds,
  limiter: RateLimiter,
  uid: number,
): Promise<SendReceipt> {
  const folders = await Folders.load(c);
  const draft = await loadDraft(c, folders, uid);
  const headers = parseHeaders(draft.raw);

  const from = parseAddressHeader(headers.undecoded("from"));
  if (from.length !== 1 || from[0]!.address.toLowerCase() !== account.user.toLowerCase()) {
    throw new ToolError(`This draft's From is not ${account.user}. Only mail from your own address can be sent. Create a new draft with save_draft.`);
  }
  const to = parseAddressHeader(headers.undecoded("to"));
  const cc = parseAddressHeader(headers.undecoded("cc"));
  const bcc = parseAddressHeader(headers.undecoded("bcc"));
  // One RCPT TO per address, even when it appears in both To and Bcc.
  const recipients = [...new Map([...to, ...cc, ...bcc].map((a) => [a.address.toLowerCase(), parseAddress(a.address).address])).values()];
  if (recipients.length === 0) throw new ToolError("This draft has no recipients. Add some with save_draft, then send.");
  assertRecipientLimit(recipients.length);

  const domain = account.user.slice(account.user.indexOf("@") + 1);
  const { wire, record, messageId } = await prepareForDelivery(draft.raw, {
    now: new Date(),
    fallbackMessageId: () => fallbackId(draft.uidValidity, draft.uid, draft.raw, domain),
  });

  const sentUids = await findInSent(c, folders.path("sent"), messageId);
  const submitted = sentUids.length > 0;
  if (!submitted && draft.flags.has(SENDING_KEYWORD)) {
    throw new ToolError(
      `An earlier send_draft of draft ${draft.uid} stopped partway, so the email may already have been delivered. Nothing was sent now. ` +
        "Ask the user to check with a recipient. If it did not arrive, save the draft again (save_draft with replaceUid, or re-save it in Apple Mail) and send the new copy.",
    );
  }
  if (!submitted) await deliverOnce(c, account, limiter, folders.path("drafts"), draft, wire, recipients);
  const after = await finalizeAfterSend(c, folders, draft, record, sentUids);

  return {
    status: submitted ? "already-sent" : "sent",
    messageId,
    to: to.map((a) => a.address),
    cc: cc.map((a) => a.address),
    bccCount: bcc.length,
    ...after,
  };
}
