import { expect, test } from "bun:test";
import { joinQuote, planForward, planReply, splitQuote, type OriginalMessage } from "../src/mail/compose";
import { BODY_LENGTH_HEADER, buildMessage, decodeOwnQuotedPrintable, parseAddress, parseHeaders } from "../src/mail/mime";

const original: OriginalMessage = {
  messageId: "<orig@example.com>",
  references: [],
  from: [parseAddress("Alice <alice@example.com>")],
  replyTo: [],
  to: [parseAddress("me@icloud.com")],
  cc: [],
  subject: "Lunch?",
  date: new Date("2026-11-01T10:00:00Z"),
  bodyText: "Are you free on Friday?\n\nLet me know. Café?",
  bodyTruncated: false,
};
const self = parseAddress("me@icloud.com");

function storeAndReload(body: string, quoted: string | null): { body: string; quoted: string | null } {
  const raw = buildMessage({
    from: self,
    to: [parseAddress("alice@example.com")],
    cc: [],
    bcc: [],
    subject: "Re: Lunch?",
    text: joinQuote(body, quoted),
    messageId: "<draft@icloud.com>",
    date: new Date("2026-11-08T12:00:00Z"),
    bodyLength: quoted ? body.length : undefined,
  });
  const h = parseHeaders(raw);
  const stored = h.decoded(BODY_LENGTH_HEADER);
  return splitQuote(decodeOwnQuotedPrintable(raw.subarray(h.bodyOffset)), stored === undefined ? null : Number(stored));
}

test("a reply quote survives save and reload without changing the body", () => {
  const { quoted } = planReply(original, { all: false, self, quote: true });
  expect(quoted).toStartWith("On Sun, 01 Nov 2026 10:00:00 UTC, Alice <alice@example.com> wrote:\n> Are you free");
  const first = storeAndReload("Yes, Friday works.", quoted);
  expect(first).toEqual({ body: "Yes, Friday works.", quoted });
});

test("editing the body and saving again keeps exactly one quote", () => {
  const { quoted } = planReply(original, { all: false, self, quote: true });
  const saved = storeAndReload("First draft", quoted);
  const edited = storeAndReload("Second draft, longer", saved.quoted);
  expect(edited.body).toBe("Second draft, longer");
  expect(edited.quoted).toBe(quoted!);
  const full = joinQuote(edited.body, edited.quoted);
  expect(full.match(/ wrote:$/gm)?.length).toBe(1);
});

test("a forward quote round-trips the same way", () => {
  const { quoted } = planForward(original, { quote: true });
  expect(quoted).toStartWith("---------- Forwarded message ----------\nFrom: Alice");
  expect(storeAndReload("FYI", quoted)).toEqual({ body: "FYI", quoted });
});

test("a draft without a quote splits to the whole body", () => {
  expect(storeAndReload("Just text", null)).toEqual({ body: "Just text", quoted: null });
});

test("an empty body in front of a quote still splits", () => {
  const { quoted } = planReply(original, { all: false, self, quote: true });
  expect(storeAndReload("", quoted)).toEqual({ body: "", quoted });
});

test("text the user wrote that looks like a quote header stays in the body", () => {
  const body = "Hi team,\n\nOn Monday the client wrote:\nplease ship by Friday\n\nThanks";
  expect(storeAndReload(body, null)).toEqual({ body, quoted: null });
  const { quoted } = planReply(original, { all: false, self, quote: true });
  expect(storeAndReload(body, quoted)).toEqual({ body, quoted });
});

test("a non-ASCII sender name is written readably in the quote", () => {
  const zoe = { ...original, from: [parseAddress("Zoë Ångström-Øverli 東京都千代田区丸の内 <z@example.com>")] };
  const { quoted } = planReply(zoe, { all: false, self, quote: true });
  expect(quoted).toStartWith("On Sun, 01 Nov 2026 10:00:00 UTC, Zoë Ångström-Øverli 東京都千代田区丸の内 <z@example.com> wrote:\n");
  expect(storeAndReload("ok", quoted)).toEqual({ body: "ok", quoted });
});

test("a truncated original is marked as cut", () => {
  const { quoted } = planForward({ ...original, bodyText: "x".repeat(100), bodyTruncated: true }, { quote: true });
  expect(quoted).toEndWith("\n[...]");
});
