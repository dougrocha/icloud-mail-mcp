import { expect, test } from "bun:test";
import type { MessageStructureObject } from "imapflow";
import { downloadAttachments, toPayload, type MailSource } from "../src/mail/attachments";
import { htmlToText } from "../src/mail/imap";

const pdf = new TextEncoder().encode("%PDF-fake");
const structure = {
  type: "multipart/mixed",
  childNodes: [
    { part: "1", type: "text/plain", size: 10 },
    { part: "2", type: "application/pdf", size: 4000, encoding: "base64", disposition: "attachment", dispositionParameters: { filename: "a.pdf" } },
    { part: "3", type: "image/png", size: 99_999_999, encoding: "base64", disposition: "attachment", parameters: { name: "big.png" } },
  ],
} as unknown as MessageStructureObject;

function fakeSource(log: string[] = []): MailSource {
  return {
    mailbox: false,
    list: async () => [{ path: "INBOX", flags: new Set(), specialUse: "\\Inbox" }],
    getMailboxLock: async (path: string, opts?: { readOnly?: boolean }) => {
      log.push(`lock ${path} ro=${opts?.readOnly}`);
      return { path, release: () => log.push("release") };
    },
    fetchOne: async () => ({ uid: 5, bodyStructure: structure }),
    download: async (_uid: string, part: string) => {
      log.push(`download ${part}`);
      return { meta: {}, content: (async function* () { yield pdf; })() };
    },
  } as unknown as MailSource;
}

test("downloads one part read-only and reports the resolved folder", async () => {
  const log: string[] = [];
  const got = await downloadAttachments(fakeSource(log), { folder: "inbox", uid: 5, parts: ["2"], maxBytes: 10 * 1024 * 1024 });
  expect(got.folder).toBe("INBOX");
  expect(got.files.map((f) => [f.part, f.filename, f.mimeType])).toEqual([["2", "a.pdf", "application/pdf"]]);
  expect(log).toEqual(["lock INBOX ro=true", "download 2", "release"]);
});

test("checks every part's size before downloading any, so nothing partial is fetched", async () => {
  const log: string[] = [];
  await expect(downloadAttachments(fakeSource(log), { folder: "inbox", uid: 5, parts: "all", maxBytes: 10 * 1024 * 1024 })).rejects.toThrow("The limit is 10.0 MB");
  expect(log.filter((l) => l.startsWith("download"))).toEqual([]);
});

test("an unknown part is refused before any download", async () => {
  await expect(downloadAttachments(fakeSource(), { folder: "inbox", uid: 5, parts: ["7"], maxBytes: 1e9 })).rejects.toThrow('Part "7"');
});

test("an unreadable PDF falls back to the file itself", async () => {
  const p = await toPayload({ part: "2", filename: "a.pdf", mimeType: "application/pdf", charset: undefined, bytes: pdf }, { format: "auto", maxChars: 1000 });
  expect(p.kind).toBe("blob");
});

test("htmlToText keeps cells apart and skips styles, comments and quoted >", () => {
  expect(htmlToText('<style>p{}</style><!--x--><table><tr><td>Total</td><td>$12</td></tr></table><a title="a>b">go</a>')).toBe("Total $12\n\ngo");
});

test("htmlToText stays linear on hostile input", () => {
  const t = performance.now();
  htmlToText("<!--".repeat(500_000));
  htmlToText("<".repeat(1_000_000));
  expect(performance.now() - t).toBeLessThan(1000);
});
