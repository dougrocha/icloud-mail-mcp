/**
 * Saves attachments as <out>/<folder>/<uid>/<part>-<name>. The filename comes from the sender,
 * so only its last path component is used and the result must stay inside <out>.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { AttachmentFile } from "../mail/attachments";

/** Writes one attachment, readable only by you, and returns its path. */
export async function saveAttachment(out: string, folder: string, uid: number, file: AttachmentFile): Promise<string> {
  const path = pathFor(out, folder, uid, file);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, file.bytes, { mode: 0o600 });
  return path;
}

export function pathFor(out: string, folder: string, uid: number, file: AttachmentFile): string {
  const dirs = folder.split("/").map((s) => safeSegment(s, "_"));
  const path = join(out, ...dirs, String(uid), `${file.part}-${fileName(file.filename, file.mimeType)}`);
  const rel = relative(out, path);
  if (isAbsolute(rel) || rel.startsWith("..")) throw new Error("Refusing to write outside the output directory.");
  return path;
}

/** One path component: no directories, no control characters, no leading dots. */
export function safeSegment(raw: string | null | undefined, fallback: string): string {
  const base = (raw ?? "").split(/[/\\]/).pop() ?? "";
  const s = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 100);
  return s || fallback;
}

/** Claude Code's Read picks its PDF and image readers by extension, so "Invoice" (application/pdf) becomes "Invoice.pdf". */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/csv": ".csv",
  "text/calendar": ".ics",
  "message/rfc822": ".eml",
  "application/zip": ".zip",
};

function fileName(filename: string | null, mimeType: string): string {
  const name = safeSegment(filename, "attachment");
  const ext = EXT_BY_MIME[mimeType];
  return ext && !/\.[A-Za-z0-9]{1,10}$/.test(name) ? `${name}${ext}` : name;
}
