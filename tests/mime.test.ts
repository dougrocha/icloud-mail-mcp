import { expect, test } from "bun:test";
import { BODY_LENGTH_HEADER, MARKER_HEADER, MARKER_VALUE, buildMessage, decodeOwnQuotedPrintable, parseAddress, parseHeaders, prepareForDelivery } from "../src/mail/mime";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const enc = (s: string) => new TextEncoder().encode(s);
const NOW = new Date("2026-11-08T12:00:00Z");
const FALLBACK = "<fallback@icloud.com>";

const draftFields = {
  from: parseAddress("me@icloud.com"),
  to: [parseAddress("you@example.com")],
  cc: [],
  bcc: [parseAddress("secret@example.com")],
  subject: "Hello",
  text: "Body line",
  messageId: "<abc@icloud.com>",
  date: NOW,
};
const draft = () => buildMessage(draftFields);

test("a freshly built draft carries Bcc and the marker header", async () => {
  const raw = dec(draft());
  expect(raw).toContain("Bcc: secret@example.com");
  expect(raw).toContain(`${MARKER_HEADER}: ${MARKER_VALUE}`);
});

test("prepareForDelivery strips Bcc and the marker but keeps the other headers and body", async () => {
  const { wire, messageId } = await prepareForDelivery(draft(), { now: NOW, fallbackMessageId: () => FALLBACK });
  const out = dec(wire);
  expect(out.toLowerCase()).not.toContain("bcc:");
  expect(out.toLowerCase()).not.toContain(MARKER_HEADER.toLowerCase());
  expect(out).not.toContain("secret@example.com");
  expect(out).toContain("To: you@example.com");
  expect(out).toContain("Body line");
  expect(messageId).toBe("<abc@icloud.com>");
});

test("prepareForDelivery adds Date and Message-ID when the draft lacks them", async () => {
  const raw = enc("From: me@icloud.com\r\nTo: you@example.com\r\nSubject: Hi\r\n\r\nbody\r\n");
  const { wire, messageId } = await prepareForDelivery(raw, { now: NOW, fallbackMessageId: () => FALLBACK });
  const h = parseHeaders(wire);
  expect(messageId).toBe(FALLBACK);
  expect(h.decoded("message-id")).toBe(FALLBACK);
  expect(h.decoded("date")).toBe("Sun, 08 Nov 2026 12:00:00 +0000");
  expect(dec(wire.subarray(h.bodyOffset))).toBe("body\r\n");
});

test("prepareForDelivery keeps the Message-ID but dates the message when it is sent", async () => {
  const { wire } = await prepareForDelivery(draft(), { now: new Date("2030-01-01T00:00:00Z"), fallbackMessageId: () => FALLBACK });
  const h = parseHeaders(wire);
  expect(h.decoded("message-id")).toBe("<abc@icloud.com>");
  expect(h.decoded("date")).toBe("Tue, 01 Jan 2030 00:00:00 +0000");
  expect(dec(wire).match(/^Date:/gim)?.length).toBe(1);
});

test("the Sent copy keeps Bcc and drops the draft-only headers", async () => {
  const raw = enc(
    `From: me@icloud.com\r\nBcc: hidden@example.com\r\nX-Uniform-Type-Identifier: com.apple.mail-draft\r\nX-Apple-Mail-Remote-Attachments: YES\r\nX-Universally-Unique-Identifier: 90D6\r\n` +
      `${MARKER_HEADER}: ${MARKER_VALUE}\r\n${BODY_LENGTH_HEADER}: 3\r\nSubject: Hi\r\n\r\nbody\r\n`,
  );
  const { wire, record } = await prepareForDelivery(raw, { now: NOW, fallbackMessageId: () => FALLBACK });
  for (const out of [dec(wire), dec(record())]) {
    expect(out.toLowerCase()).not.toContain("x-apple-");
    expect(out.toLowerCase()).not.toContain("x-uniform-type-identifier");
    expect(out.toLowerCase()).not.toContain("x-universally-unique-identifier");
    expect(out.toLowerCase()).not.toContain(MARKER_HEADER.toLowerCase());
  }
  expect(dec(wire)).not.toContain("hidden@example.com");
  expect(dec(record())).toContain("Bcc: hidden@example.com");
});

test("only standard headers are delivered, so an unknown draft header is dropped", async () => {
  const raw = enc("From: me@icloud.com\r\nX-Some-Client-Draft-State: 7\r\nReply-To: r@example.com\r\nContent-Type: text/plain\r\nSubject: Hi\r\n\r\nbody\r\n");
  const out = dec((await prepareForDelivery(raw, { now: NOW, fallbackMessageId: () => FALLBACK })).wire);
  expect(out).not.toContain("X-Some-Client-Draft-State");
  expect(out).toContain("Reply-To: r@example.com\r\nContent-Type: text/plain\r\nSubject: Hi\r\n");
  expect(out).toEndWith("\r\n\r\nbody\r\n");
});

test("a header line over the RFC 5322 hard limit is refused", async () => {
  expect(() => buildMessage({ ...draftFields, subject: "x".repeat(1000) })).toThrow("Subject header would have a line over 998");
});

test("a bare CR inside a header cannot smuggle a Bcc line onto the wire", async () => {
  const raw = enc("From: me@icloud.com\r\nSubject: hi\rBcc: secret@x.com\r\nTo: you@example.com\r\n\r\nbody\r\n");
  const out = dec((await prepareForDelivery(raw, { now: NOW, fallbackMessageId: () => FALLBACK })).wire);
  expect(out).not.toContain("secret@x.com");
  expect(out).toContain("To: you@example.com");
});

test("quoted-printable decoding keeps 8-bit bytes and a leading BOM", async () => {
  expect(decodeOwnQuotedPrintable(enc("\ufeffcaf=C3=A9 \u20ac =\r\n5"))).toBe("\ufeffcafé € 5");
});

test("an empty Message-ID header gets the fallback id", async () => {
  const raw = enc("From: me@icloud.com\r\nMessage-ID:\r\nTo: you@example.com\r\n\r\nbody\r\n");
  expect((await prepareForDelivery(raw, { now: NOW, fallbackMessageId: () => FALLBACK })).messageId).toBe(FALLBACK);
});

test("a long subject is folded under the header line limit", async () => {
  const subject = Array.from({ length: 150 }, (_, i) => `word${i}`).join(" ");
  const raw = buildMessage({ ...draftFields, subject });
  const lines = dec(raw).split("\r\n");
  expect(Math.max(...lines.map((l) => l.length))).toBeLessThanOrEqual(78);
  expect(parseHeaders(raw).decoded("subject")).toBe(subject);
});

test("decoding keeps the space between a plain word and an encoded word", async () => {
  const h = parseHeaders(enc("Subject: Hello =?utf-8?B?w6k=?= world\r\n\r\n"));
  expect(h.decoded("subject")).toBe("Hello é world");
});

test("prepareForDelivery strips a folded Bcc header completely", async () => {
  const raw = enc(
    `From: me@icloud.com\r\nBcc: a@example.com,\r\n b@example.com\r\n${MARKER_HEADER}: ${MARKER_VALUE}\r\nSubject: Hi\r\n\r\nbody\r\n`,
  );
  const out = dec((await prepareForDelivery(raw, { now: NOW, fallbackMessageId: () => FALLBACK })).wire);
  expect(out).not.toContain("b@example.com");
  expect(out).toContain("Subject: Hi");
});
