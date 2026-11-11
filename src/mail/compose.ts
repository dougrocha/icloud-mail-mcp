import { displayAddress, type Address } from "./mime";

export interface OriginalMessage {
  readonly messageId: string | null;
  readonly references: readonly string[];
  readonly from: readonly Address[];
  readonly replyTo: readonly Address[];
  readonly to: readonly Address[];
  readonly cc: readonly Address[];
  readonly subject: string;
  readonly date: Date | null;
  readonly bodyText: string;
  /** The original was longer than MAX_QUOTE_CHARS and bodyText holds only its start. */
  readonly bodyTruncated: boolean;
}

interface Threading {
  readonly to: readonly Address[];
  readonly cc: readonly Address[];
  readonly subject: string;
  readonly inReplyTo: string | undefined;
  readonly references: readonly string[];
  readonly quoted: string;
}

const FORWARD_BANNER = "---------- Forwarded message ----------";
export const MAX_QUOTE_CHARS = 20_000;
const MAX_REFERENCES = 10;

const lower = (a: Address) => a.address.toLowerCase();

function dedupe(list: readonly Address[], exclude: ReadonlySet<string>): Address[] {
  const seen = new Set(exclude);
  const out: Address[] = [];
  for (const a of list) {
    if (seen.has(lower(a))) continue;
    seen.add(lower(a));
    out.push(a);
  }
  return out;
}

const fmtDate = (d: Date | null) => (d ? d.toUTCString().replace(/ GMT$/, " UTC") : "an unknown date");
const cut = (o: OriginalMessage) =>
  o.bodyTruncated || o.bodyText.length > MAX_QUOTE_CHARS ? `${o.bodyText.slice(0, MAX_QUOTE_CHARS)}\n[...]` : o.bodyText;

function quoteReply(o: OriginalMessage): string {
  const who = o.from[0] ? displayAddress(o.from[0]) : "the sender";
  const body = cut(o)
    .split(/\r?\n/)
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
  return `On ${fmtDate(o.date)}, ${who} wrote:\n${body}`;
}

function quoteForward(o: OriginalMessage): string {
  const join = (l: readonly Address[]) => l.map(displayAddress).join(", ");
  const head = [
    FORWARD_BANNER,
    `From: ${join(o.from)}`,
    `Date: ${fmtDate(o.date)}`,
    `Subject: ${o.subject}`,
    ...(o.to.length ? [`To: ${join(o.to)}`] : []),
    ...(o.cc.length ? [`Cc: ${join(o.cc)}`] : []),
  ];
  return `${head.join("\n")}\n\n${cut(o)}`;
}

export function planReply(o: OriginalMessage, opts: { all: boolean; self: Address; quote: boolean }): Threading {
  const self = new Set([lower(opts.self)]);
  const primary = o.replyTo.length ? o.replyTo : o.from;
  let to = dedupe(primary, self);
  if (to.length === 0) to = dedupe(o.to, self);
  const cc = opts.all ? dedupe([...o.to, ...o.cc], new Set([...self, ...to.map(lower)])) : [];
  const refs = [...new Set([...o.references, ...(o.messageId ? [o.messageId] : [])])];
  return {
    to,
    cc,
    subject: `Re: ${o.subject.replace(/^(?:\s*(?:re|aw|sv|antw)\s*:)+\s*/i, "")}`,
    inReplyTo: o.messageId ?? undefined,
    references: refs.length > MAX_REFERENCES ? [refs[0]!, ...refs.slice(-(MAX_REFERENCES - 1))] : refs,
    quoted: opts.quote ? quoteReply(o) : "",
  };
}

export function planForward(o: OriginalMessage, opts: { quote: boolean }): Threading {
  return {
    to: [],
    cc: [],
    subject: /^\s*fwd?\s*:/i.test(o.subject) ? o.subject : `Fwd: ${o.subject}`,
    inReplyTo: undefined,
    references: [],
    quoted: opts.quote ? quoteForward(o) : "",
  };
}

const SEPARATOR = "\n\n";

export const joinQuote = (body: string, quoted: string | null): string => (quoted ? `${body}${SEPARATOR}${quoted}` : body);

/** Undo joinQuote, given the body length stored with the draft. Without one, the whole text is the body. */
export function splitQuote(text: string, bodyLength: number | null): { body: string; quoted: string | null } {
  if (bodyLength === null || bodyLength > text.length) return { body: text.trimEnd(), quoted: null };
  const rest = text.slice(bodyLength);
  const quoted = rest.startsWith(SEPARATOR) ? rest.slice(SEPARATOR.length).trimEnd() : "";
  return { body: text.slice(0, bodyLength), quoted: quoted || null };
}
