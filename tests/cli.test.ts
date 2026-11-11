import { expect, test } from "bun:test";
// A static import: if the CLI ever reaches cloudflare:*, this file fails to load and the suite fails.
import { parseDevVars } from "../src/cli/attachment";
import { pathFor, safeSegment } from "../src/cli/files";
import type { AttachmentFile } from "../src/mail/attachments";

const file = (over: Partial<AttachmentFile> = {}): AttachmentFile => ({
  part: "2",
  filename: "Invoice.pdf",
  mimeType: "application/pdf",
  charset: undefined,
  bytes: new Uint8Array(),
  ...over,
});

test("parseDevVars keeps $ and strips quotes", () => {
  const vars = parseDevVars('# c\nICLOUD_USER="me@icloud.com"\nICLOUD_APP_PASSWORD=pa$$word\n');
  expect(vars).toEqual({ ICLOUD_USER: "me@icloud.com", ICLOUD_APP_PASSWORD: "pa$$word" });
});

test("hostile filenames become one safe path component", () => {
  expect(safeSegment("../../.zshrc", "x")).toBe("zshrc");
  expect(safeSegment("a\u0000b", "x")).toBe("ab");
  expect(safeSegment("...", "attachment")).toBe("attachment");
});

test("pathFor nests by folder, uid and part, and adds a missing extension", () => {
  const out = "/out";
  expect(pathFor(out, "Work/Clients", 7, file())).toBe("/out/Work/Clients/7/2-Invoice.pdf");
  expect(pathFor(out, "INBOX", 7, file({ filename: "Invoice" }))).toBe("/out/INBOX/7/2-Invoice.pdf");
  expect(pathFor(out, "..", 7, file({ filename: null, mimeType: "image/png" }))).toBe("/out/_/7/2-attachment.png");
});
