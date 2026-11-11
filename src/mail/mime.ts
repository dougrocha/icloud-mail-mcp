import { addressParser, decodeWords } from "postal-mime";
import { base64, concatBytes } from "./bytes";
import { ToolError } from "./errors";

export const MARKER_HEADER = "X-Icloud-Mail-Mcp";
export const MARKER_VALUE = "draft";
/** Where the user's text ends and the quoted original begins, in characters of the decoded body. */
export const BODY_LENGTH_HEADER = "X-Icloud-Mail-Mcp-Body-Length";
export const MAX_RECIPIENTS = 25;

export function assertRecipientLimit(count: number): void {
  if (count > MAX_RECIPIENTS) {
    throw new ToolError(`This draft has ${count} recipients across To, Cc and Bcc. The limit is ${MAX_RECIPIENTS}.`);
  }
}

/**
 * The top-level headers that leave with a sent message. Anything else on a draft (ours, Apple Mail's
 * X-Apple-* and UUID headers, whatever a future client adds) stays behind. Date is replaced at send time.
 */
const DELIVERED_HEADERS = new Set([
  "from", "sender", "reply-to", "to", "cc", "subject", "message-id", "in-reply-to", "references",
  "mime-version", "importance", "priority", "x-priority", "comments", "keywords",
  "disposition-notification-to", "return-receipt-to", "autocrypt", "openpgp", "thread-index", "thread-topic",
]);
const isDelivered = (name: string) => DELIVERED_HEADERS.has(name) || name.startsWith("content-");

const RFC5322_LINE_LIMIT = 78;
/** RFC 5322 2.1.1: the hard limit, excluding CRLF. */
const RFC5322_HARD_LINE_LIMIT = 998;

export interface Address {
  readonly name?: string;
  readonly address: string;
}

interface OutgoingMessage {
  readonly from: Address;
  readonly to: readonly Address[];
  readonly cc: readonly Address[];
  readonly bcc: readonly Address[];
  readonly subject: string;
  readonly text: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly messageId: string;
  readonly date: Date;
  readonly bodyLength?: number;
}

const SPECIALS = /[\x00-\x1f\x7f]/;
const ADDR_SPEC = /^[\x21-\x7e]+@[\x21-\x7e]+$/;
const BAD_ADDR_CHARS = /[<>"(),;:\\[\]\s]/;

function noCRLF(label: string, v: string): string {
  if (/[\r\n]/.test(v)) throw new ToolError(`${label} must not contain line breaks.`);
  return v;
}

function addrSpec(raw: string): string {
  const a = raw.trim();
  const at = a.indexOf("@");
  if (!ADDR_SPEC.test(a) || at < 1 || at !== a.lastIndexOf("@") || at === a.length - 1 || BAD_ADDR_CHARS.test(a)) {
    throw new ToolError(
      `"${a.slice(0, 80)}" is not a usable email address. Pass one address per entry, as "a@b.com" or "Name <a@b.com>" (ASCII addresses only).`,
    );
  }
  return a;
}

export function parseAddress(input: string): Address {
  noCRLF("An address", input);
  const s = input.trim();
  const m = /^(.*?)\s*<([^<>]*)>$/.exec(s);
  if (!m) return { address: addrSpec(s) };
  let name = m[1]!.trim();
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) name = name.slice(1, -1).replace(/\\(.)/g, "$1");
  if (SPECIALS.test(name)) throw new ToolError("A display name contains control characters.");
  const address = addrSpec(m[2]!);
  return name ? { name, address } : { address };
}

export const parseAddresses = (inputs: readonly string[]): Address[] => inputs.map(parseAddress);

export function parseAddressHeader(value: string | undefined): Address[] {
  if (!value) return [];
  const out: Address[] = [];
  for (const m of addressParser(value, { flatten: true })) {
    if (!m.address) continue;
    out.push(m.name ? { name: m.name, address: m.address } : { address: m.address });
  }
  return out;
}

export function tryAddress(a: { name?: string | undefined; address?: string | undefined }): Address | null {
  if (!a.address) return null;
  try {
    const address = addrSpec(a.address);
    const name = a.name?.trim();
    return name && !SPECIALS.test(name) ? { name, address } : { address };
  } catch {
    return null;
  }
}

/** For text people read (a quote line, a tool result), not for a header. */
export const displayAddress = (a: Address): string => (a.name ? `${a.name} <${a.address}>` : a.address);

function formatAddress(a: Address): string {
  if (!a.name) return a.address;
  return `${formatDisplayName(a.name)} <${a.address}>`;
}

function formatDisplayName(name: string): string {
  if (/^[\x20-\x7e]*$/.test(name)) {
    return /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name) ? name : `"${name.replace(/(["\\])/g, "\\$1")}"`;
  }
  return encodeWords(name);
}

const utf8 = new TextEncoder();

/** RFC 2047: an encoded-word may not exceed 75 chars. */
function encodeWords(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const MAX_BYTES = 45; // 45 bytes -> 60 base64 chars + 12 framing = 72 <= 75
  const words: string[] = [];
  let cur: string[] = [];
  let curBytes = 0;
  const flush = () => {
    if (cur.length) words.push(`=?utf-8?B?${base64(utf8.encode(cur.join("")))}?=`);
    cur = [];
    curBytes = 0;
  };
  for (const ch of s) {
    const n = utf8.encode(ch).length;
    if (curBytes + n > MAX_BYTES) flush();
    cur.push(ch);
    curBytes += n;
  }
  flush();
  return words.join("\r\n ");
}

function fold(name: string, value: string): string {
  if (value.includes("\r\n")) return `${name}: ${value}`;
  const lines: string[] = [];
  let line = `${name}:`;
  for (const word of value.split(" ")) {
    if (line.length + 1 + word.length > RFC5322_LINE_LIMIT && line !== `${name}:`) {
      lines.push(line);
      line = ` ${word}`;
    } else line += ` ${word}`;
  }
  lines.push(line);
  return lines.join("\r\n");
}

function foldAddresses(name: string, list: readonly Address[]): string {
  const items = list.map(formatAddress);
  const lines: string[] = [];
  let line = `${name}: ${items[0]}`;
  for (const it of items.slice(1)) {
    if (line.length + 2 + it.length > RFC5322_LINE_LIMIT) {
      lines.push(`${line},`);
      line = ` ${it}`;
    } else line += `, ${it}`;
  }
  lines.push(line);
  return lines.join("\r\n");
}

function rfcDate(d: Date): string {
  return d.toUTCString().replace(/ GMT$/, " +0000");
}

const MSGID = /^<[^\s<>]+>$/;
export const isMessageId = (s: string) => MSGID.test(s);
export const parseMessageIds = (value: string | undefined): string[] => (value ?? "").split(/\s+/).filter(isMessageId);

/** RFC 2045: quoted-printable lines may not exceed 76 chars, including the soft-break "=". */
function encodeQP(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const bytes = utf8.encode(line);
    let cur = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const trailingWs = (b === 0x20 || b === 0x09) && i === bytes.length - 1;
      const tok =
        (b >= 33 && b <= 126 && b !== 61) || ((b === 0x20 || b === 0x09) && !trailingWs)
          ? String.fromCharCode(b)
          : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
      if (cur.length + tok.length > 75) {
        out.push(`${cur}=`);
        cur = "";
      }
      cur += tok;
    }
    out.push(cur);
  }
  return out.join("\r\n") + "\r\n";
}

export function buildMessage(m: OutgoingMessage): Uint8Array {
  noCRLF("Subject", m.subject);
  const h: string[] = [`Date: ${rfcDate(m.date)}`, foldAddresses("From", [m.from])];
  if (m.to.length) h.push(foldAddresses("To", m.to));
  if (m.cc.length) h.push(foldAddresses("Cc", m.cc));
  if (m.bcc.length) h.push(foldAddresses("Bcc", m.bcc));
  h.push(fold("Subject", encodeWords(m.subject)));
  if (!MSGID.test(m.messageId)) throw new Error("invalid Message-ID");
  h.push(`Message-ID: ${m.messageId}`);
  if (m.inReplyTo && MSGID.test(m.inReplyTo)) h.push(`In-Reply-To: ${m.inReplyTo}`);
  const refs = (m.references ?? []).filter((r) => MSGID.test(r));
  if (refs.length) h.push(`References: ${refs.join("\r\n ")}`);
  const tooLong = h.find((field) => field.split("\r\n").some((l) => l.length > RFC5322_HARD_LINE_LIMIT));
  if (tooLong) {
    const name = tooLong.slice(0, tooLong.indexOf(":"));
    throw new ToolError(`The ${name} header would have a line over ${RFC5322_HARD_LINE_LIMIT} characters. Shorten it.`);
  }
  h.push(
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    `${MARKER_HEADER}: ${MARKER_VALUE}`,
  );
  if (m.bodyLength !== undefined) h.push(`${BODY_LENGTH_HEADER}: ${m.bodyLength}`);
  return utf8.encode(`${h.join("\r\n")}\r\n\r\n${encodeQP(m.text)}`);
}

const hexValue = (b: number) => (b >= 0x30 && b <= 0x39 ? b - 0x30 : b >= 0x41 && b <= 0x46 ? b - 0x37 : b >= 0x61 && b <= 0x66 ? b - 0x57 : -1);

/** Decodes a quoted-printable body byte by byte, so raw 8-bit bytes pass through unchanged. */
export function decodeOwnQuotedPrintable(bytes: Uint8Array): string {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b !== 0x3d) {
      out[n++] = b;
      continue;
    }
    if (bytes[i + 1] === 0x0d && bytes[i + 2] === 0x0a) i += 2;
    else if (bytes[i + 1] === 0x0a) i += 1;
    else {
      const hi = hexValue(bytes[i + 1] ?? -1);
      const lo = hexValue(bytes[i + 2] ?? -1);
      if (hi >= 0 && lo >= 0) {
        out[n++] = hi * 16 + lo;
        i += 2;
      } else out[n++] = b;
    }
  }
  // ignoreBOM keeps a leading U+FEFF, so lengths match the Body-Length header.
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(out.subarray(0, n)).replace(/\r\n/g, "\n");
}

interface ParsedHeaders {
  decoded(name: string): string | undefined;
  undecoded(name: string): string | undefined;
  readonly bodyOffset: number;
}

interface Field {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly valueStart: number;
}

function scanFields(raw: Uint8Array): { fields: Field[]; bodyOffset: number } {
  const fields: Field[] = [];
  let pos = 0;
  let cur: { name: string; start: number; valueStart: number } | null = null;
  const close = (end: number) => {
    if (cur) fields.push({ ...cur, end });
    cur = null;
  };
  while (pos < raw.length) {
    // CRLF, bare LF and bare CR all end a line, as they do when dataChunks puts the message on the wire.
    let contentEnd = pos;
    while (contentEnd < raw.length && raw[contentEnd] !== 0x0d && raw[contentEnd] !== 0x0a) contentEnd++;
    const next = contentEnd + (raw[contentEnd] === 0x0d && raw[contentEnd + 1] === 0x0a ? 2 : contentEnd < raw.length ? 1 : 0);
    if (contentEnd === pos) {
      close(pos);
      return { fields, bodyOffset: next };
    }
    const first = raw[pos]!;
    const isContinuation = (first === 0x20 || first === 0x09) && cur !== null;
    if (!isContinuation) {
      close(pos);
      let colon = pos;
      while (colon < contentEnd && raw[colon] !== 0x3a) colon++;
      if (colon < contentEnd) {
        let name = "";
        for (let i = pos; i < colon; i++) name += String.fromCharCode(raw[i]!);
        cur = { name: name.trim().toLowerCase(), start: pos, valueStart: colon + 1 };
      }
    }
    pos = next;
  }
  close(raw.length);
  return { fields, bodyOffset: raw.length };
}

function decodeBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export function parseHeaders(raw: Uint8Array): ParsedHeaders {
  const { fields, bodyOffset } = scanFields(raw);
  const rawValue = (name: string) => {
    const f = fields.find((x) => x.name === name.toLowerCase());
    if (!f) return undefined;
    return decodeBytes(raw.subarray(f.valueStart, f.end)).replace(/(?:\r\n?|\n)(?=[ \t])/g, "").replace(/(?:\r\n?|\n)$/, "").trim();
  };
  return {
    bodyOffset,
    undecoded: rawValue,
    decoded(name) {
      const v = rawValue(name);
      return v === undefined ? undefined : decodeWords(v);
    },
  };
}

interface Prepared {
  /** The bytes recipients get: only DELIVERED_HEADERS, dated now. */
  readonly wire: Uint8Array;
  /** The copy for Sent: the same message with Bcc kept. Built on demand, since a retry may not need it. */
  readonly record: () => Uint8Array;
  readonly messageId: string;
}

/** Calls `fallbackMessageId` only when the draft has no Message-ID of its own. */
export async function prepareForDelivery(
  raw: Uint8Array,
  opts: { now: Date; fallbackMessageId: () => string | Promise<string> },
): Promise<Prepared> {
  const { fields } = scanFields(raw);
  const existingId = parseHeaders(raw).decoded("message-id");
  if (existingId && !MSGID.test(existingId)) throw new ToolError("This draft has a malformed Message-ID header, so it cannot be sent safely.");
  const messageId = existingId || (await opts.fallbackMessageId());
  if (!MSGID.test(messageId)) throw new Error("invalid Message-ID");

  const headerEnd = fields.at(-1)?.end ?? 0;
  const added = utf8.encode(`Date: ${rfcDate(opts.now)}\r\n${existingId ? "" : `Message-ID: ${messageId}\r\n`}`);
  const rebuild = (keep: (name: string) => boolean) =>
    concatBytes(...fields.filter((f) => keep(f.name)).map((f) => raw.subarray(f.start, f.end)), added, raw.subarray(headerEnd));
  return {
    wire: rebuild(isDelivered),
    record: () => rebuild((name) => name === "bcc" || isDelivered(name)),
    messageId,
  };
}
