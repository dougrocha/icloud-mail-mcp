import {
  ImapFlow,
  type ImapFlowOptions,
  type MessageStructureObject,
  type SearchObject,
} from "imapflow";
import PostalMime from "postal-mime";
import { concatBytes } from "./bytes";
import { noMessage } from "./errors";
import { Folders, declaredUse, type FolderRole } from "./folders";

const IMAP_HOST = "imap.mail.me.com";
const IMAP_PORT = 993;

export interface Creds {
  user: string; // full iCloud address, e.g. you@icloud.com
  pass: string; // app-specific password
}

/**
 * How bytes reach the IMAP server, chosen by the caller that knows its runtime: the Worker passes
 * `createSocketsTransport(connect)` from cloudflare:sockets (src/server.ts), the local CLI passes "node-tls"
 * for imapflow's own TCP/TLS. Required, so a Worker caller cannot fall through to nodejs_compat's node:tls.
 * This module never imports cloudflare:*, so it and everything built on it also run under Bun.
 */
export type ImapTransport = NonNullable<ImapFlowOptions["transport"]> | "node-tls";

/** Runs `fn` on a fresh logged-in connection and always logs out, whether `fn` resolves or throws. */
export type ImapRunner = <T>(fn: (c: ImapFlow) => Promise<T>) => Promise<T>;

/** One connection per call, never pooled: a Worker socket cannot outlive its request. */
export function imapRunner(creds: Creds, transport: ImapTransport): ImapRunner {
  return async (fn) => {
    const client = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: { user: creds.user, pass: creds.pass },
      ...(transport === "node-tls" ? {} : { transport }),
      logger: false,
      // Deflate would run on the Worker's CPU for every payload, mostly base64 that does not compress.
      disableCompression: true,
    });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => client.close());
    }
  };
}

const locked = new WeakSet<object>();

/** imapflow queues getMailboxLock() per connection, so taking a lock while holding one deadlocks. */
export async function withMailbox<C extends Pick<ImapFlow, "getMailboxLock">, T>(
  c: C,
  path: string,
  opts: { readOnly?: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  if (locked.has(c)) throw new Error("withMailbox called while this connection already holds a mailbox lock");
  const lock = await c.getMailboxLock(path, opts);
  locked.add(c);
  try {
    return await fn();
  } finally {
    locked.delete(c);
    lock.release();
  }
}

interface FolderSummary {
  path: string;
  specialUse: string | null;
  role: FolderRole | null;
  messages: number | null;
  unseen: number | null;
}

export async function listFolders(c: ImapFlow): Promise<FolderSummary[]> {
  const boxes = await c.list({ statusQuery: { messages: true, unseen: true } });
  const folders = Folders.fromListing(boxes);
  return boxes.map((b) => ({
    path: b.path,
    specialUse: declaredUse(b.flags) ?? b.specialUse ?? null,
    role: folders.roleOf(b.path),
    messages: b.status?.messages ?? null,
    unseen: b.status?.unseen ?? null,
  }));
}

interface SearchArgs {
  folder: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
  unreadOnly?: boolean;
  limit: number;
}

export async function searchMessages(c: ImapFlow, a: SearchArgs) {
  const folder = await Folders.resolveIn(c, a.folder);
  return withMailbox(c, folder, { readOnly: true }, async () => {
    const q: SearchObject = {};
    if (a.from) q.from = a.from;
    if (a.to) q.to = a.to;
    if (a.subject) q.subject = a.subject;
    if (a.text) q.text = a.text;
    if (a.since) q.since = new Date(`${a.since}T00:00:00Z`);
    if (a.before) q.before = new Date(`${a.before}T00:00:00Z`);
    if (a.unreadOnly) q.seen = false;
    if (Object.keys(q).length === 0) q.all = true;

    const uids = (await c.search(q, { uid: true })) || [];
    const picked = uids.slice(-a.limit);
    if (picked.length === 0) return { total: 0, messages: [] };

    const out = [];
    for await (const m of c.fetch(picked, { uid: true, envelope: true, flags: true, internalDate: true, size: true }, { uid: true })) {
      out.push({
        uid: m.uid,
        date: toIso(m.internalDate ?? m.envelope?.date),
        from: fmtAddrs(m.envelope?.from),
        to: fmtAddrs(m.envelope?.to),
        subject: m.envelope?.subject ?? "",
        unread: !m.flags?.has("\\Seen"),
        flagged: !!m.flags?.has("\\Flagged"),
        size: m.size ?? null,
      });
    }
    out.sort((x, y) => y.uid - x.uid);
    return { total: uids.length, messages: out };
  });
}

/** Workers isolates have 128 MB of memory. */
const MAX_TEXT_PART_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_PARTS = 20;

export async function readMessage(c: ImapFlow, folderInput: string, uid: number, maxChars: number) {
  const folder = await Folders.resolveIn(c, folderInput);
  return withMailbox(c, folder, { readOnly: true }, async () => {
    const m = await c.fetchOne(
      String(uid),
      { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true },
      { uid: true },
    );
    if (!m || !m.bodyStructure) throw noMessage(folderInput, uid);

    const parts = classifyParts(m.bodyStructure);
    const { attachments } = parts;
    const { text: body, truncated } = await extractBodyText(c, uid, parts, maxChars);

    const e = m.envelope;
    return {
      uid,
      folder,
      date: toIso(m.internalDate ?? e?.date),
      from: fmtAddrs(e?.from),
      to: fmtAddrs(e?.to),
      cc: fmtAddrs(e?.cc),
      subject: e?.subject ?? "",
      messageId: e?.messageId ?? null,
      inReplyTo: e?.inReplyTo ?? null,
      unread: !m.flags?.has("\\Seen"),
      attachments,
      body,
      truncated,
    };
  });
}

type Part = MessageStructureObject;

interface Attachment {
  /** IMAP body part number ("2", "1.2"). A single-part message's body is part "1". */
  part: string;
  filename: string | null;
  mimeType: string;
  size: number | null;
}

/**
 * An estimate for rejecting oversized parts before downloading them. The byte count while
 * downloading is the real limit. BODYSTRUCTURE reports the transfer-encoded size, and base64
 * carries 3 bytes per 4 characters in lines of 76 plus CRLF.
 */
export function decodedSize(n: Part): number | null {
  if (n.size == null) return null;
  if (n.encoding?.toLowerCase() !== "base64") return n.size;
  const lineBreakBytes = 2 * Math.floor(n.size / 78);
  return Math.floor(((n.size - lineBreakBytes) * 3) / 4);
}

export function classifyParts(root: Part): {
  plains: Part[];
  htmls: Part[];
  attachments: Attachment[];
  leaves: ReadonlyMap<string, Part>;
} {
  const plains: Part[] = [];
  const htmls: Part[] = [];
  const attachments: Attachment[] = [];
  const leaves = new Map<string, Part>();
  const walk = (n: Part) => {
    const type = n.type.toLowerCase();
    if (type.startsWith("multipart/") && n.childNodes) return n.childNodes.forEach(walk);
    const filename = n.dispositionParameters?.filename ?? n.parameters?.name ?? null;
    // Only an explicit attachment disposition demotes text: some senders put a name= on the body.
    const inlineText = n.disposition?.toLowerCase() !== "attachment";
    if (inlineText && type === "text/plain") plains.push(n);
    else if (inlineText && type === "text/html") htmls.push(n);
    else {
      const part = n.part ?? "1";
      attachments.push({ part, filename, mimeType: type, size: decodedSize(n) });
      leaves.set(part, n);
    }
  };
  walk(root);
  return { plains, htmls, attachments, leaves };
}

export async function extractBodyText(
  c: ImapFlow,
  uid: number,
  { plains, htmls }: { plains: Part[]; htmls: Part[] },
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  // Apple Mail splits the plain body into several parts around inline images.
  for (const [parts, toText] of [[plains, (t: string) => t], [htmls, htmlToText]] as const) {
    if (!parts.length) continue;
    const text = (await fetchText(c, uid, parts)).map(toText).join("\n\n").trim();
    if (text) return clip(text, maxChars);
  }
  return { text: "", truncated: false };
}

export const clip = (text: string, maxChars: number) =>
  text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false };

async function fetchText(c: ImapFlow, uid: number, parts: Part[]): Promise<string[]> {
  const keyed = parts.slice(0, MAX_TEXT_PARTS).map((p) => ({ p, key: p.part ?? "1" }));
  const got = await c.fetchOne(
    String(uid),
    { uid: true, bodyParts: keyed.map(({ key }) => ({ key, maxLength: MAX_TEXT_PART_BYTES })) },
    { uid: true },
  );
  const raws = keyed.map(({ p, key }) => [p, got ? got.bodyParts?.get(key) : undefined] as const);
  return Promise.all(raws.filter(([, raw]) => raw).map(([p, raw]) => decodePart(p, raw!)));
}

const encoder = new TextEncoder();

/**
 * Undo transfer encoding and charset by handing postal-mime a one-part message (it has no
 * standalone part decoder). All Content-Type parameters are kept so format=flowed still unfolds.
 */
async function decodePart(n: Part, raw: Uint8Array): Promise<string> {
  const params = { charset: "utf-8", ...n.parameters };
  const ct = [n.type, ...Object.entries(params).map(([k, v]) => `${k}="${String(v).replace(/["\r\n]/g, "")}"`)].join("; ");
  const head = encoder.encode(`Content-Type: ${ct}\r\nContent-Transfer-Encoding: ${n.encoding ?? "7bit"}\r\n\r\n`);
  const p = await PostalMime.parse(concatBytes(head, raw));
  return (n.type.toLowerCase() === "text/html" ? p.html : p.text) ?? "";
}

function toIso(d: Date | string | undefined): string | null {
  if (!d) return null;
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? String(d) : x.toISOString();
}

type Addr = { name?: string; address?: string; group?: Addr[] };
function fmtAddr(a: Addr): string {
  if (a.group) return a.group.map(fmtAddr).join(", ");
  return a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? "");
}
function fmtAddrs(list?: Addr[]): string {
  return (list ?? []).map(fmtAddr).join(", ");
}

const NAMED: Record<string, string> = {
  nbsp: " ", lt: "<", gt: ">", quot: '"', apos: "'", amp: "&", rsquo: "\u2019", lsquo: "\u2018",
  rdquo: "\u201d", ldquo: "\u201c", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", copy: "\u00a9", reg: "\u00ae",
  trade: "\u2122", zwnj: "", zwj: "", shy: "",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const INVISIBLE_PREHEADER_CHARS = /[\u00ad\u034f\u200b-\u200d\u2060\ufeff]/g;

const SKIPPED_ELEMENTS = new Set(["script", "style", "head", "title"]);
const LINE_BREAK_ELEMENTS = new Set(["br", "p", "div", "tr", "li", "table", "h1", "h2", "h3", "h4", "h5", "h6"]);
const CELL_ELEMENTS = new Set(["td", "th"]);

/** Index just past the `>` that closes the tag starting at `lt`, skipping `>` inside quoted attribute values. */
function tagEnd(html: string, lt: number): number {
  let quote = "";
  for (let i = lt + 1; i < html.length; i++) {
    const ch = html[i]!;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i + 1;
  }
  return -1;
}

/**
 * One left-to-right pass, so input a sender controls cannot make it slower than linear.
 * An unclosed comment, tag or skipped element ends the text there.
 */
export function htmlToText(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      if (close < 0) break;
      i = close + 3;
      continue;
    }
    const end = tagEnd(html, lt);
    if (end < 0) break;
    const name = /^<\/?([a-z][a-z0-9]*)/i.exec(html.slice(lt, Math.min(end, lt + 12)))?.[1]?.toLowerCase() ?? "";
    const closing = html[lt + 1] === "/";
    i = end;
    if (!closing && SKIPPED_ELEMENTS.has(name)) {
      const close = lower.indexOf(`</${name}`, end);
      if (close < 0) break;
      const after = tagEnd(html, close);
      if (after < 0) break;
      i = after;
    } else if (LINE_BREAK_ELEMENTS.has(name) && (closing || name === "br")) out.push("\n");
    else if (CELL_ELEMENTS.has(name) && closing) out.push(" ");
  }
  return decodeEntities(out.join(""))
    .replace(INVISIBLE_PREHEADER_CHARS, "")
    .replace(/[\u00a0\u2007]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
