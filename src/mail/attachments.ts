import type { ImapFlow, MessageStructureObject } from "imapflow";
import { base64 } from "./bytes";
import { ToolError, noMessage } from "./errors";
import { Folders } from "./folders";
import { classifyParts, clip, decodedSize, htmlToText, withMailbox } from "./imap";

/** The Worker's limit: a 128 MB isolate holds the bytes, a base64 copy and the JSON result at once. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** An IMAP body part id as read_message reports it: "2", "1.2". */
export const PART_ID = /^\d+(\.\d+)*$/;
/** imapflow fetches 64 KB per round trip by default, which is hundreds of round trips for a large file. */
const DOWNLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_PDF_PAGES = 100;

/** Only the imapflow calls a download makes, so tests can pass a small fake. */
export type MailSource = Pick<ImapFlow, "list" | "getMailboxLock" | "fetchOne" | "download" | "mailbox">;

interface DownloadRequest {
  readonly folder: string;
  readonly uid: number;
  /** Explicit part ids, or every attachment read_message lists for the message. */
  readonly parts: readonly [string, ...string[]] | "all";
  readonly maxBytes: number;
}

/** One downloaded attachment. `filename` comes from the sender and is untrusted. */
export interface AttachmentFile {
  readonly part: string;
  readonly filename: string | null;
  readonly mimeType: string;
  readonly charset: string | undefined;
  readonly bytes: Uint8Array;
}

interface DownloadedAttachments {
  /** The resolved folder path, so "inbox" and "INBOX" name the same place. */
  readonly folder: string;
  readonly uid: number;
  readonly files: readonly AttachmentFile[];
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const tooBig = (n: number, limit: number) => new ToolError(`This attachment is ${mb(n)}. The limit is ${mb(limit)}.`);

/**
 * The one way attachments leave the mailbox, for the MCP tool and the local CLI alike. Opens the folder
 * read-only (nothing is marked read) and checks every requested part, including its declared size,
 * before downloading any, so a request either gets every file or fails without a partial set.
 */
export function downloadAttachments(
  c: MailSource,
  req: DownloadRequest & { parts: readonly [string] },
): Promise<DownloadedAttachments & { files: readonly [AttachmentFile] }>;
export function downloadAttachments(c: MailSource, req: DownloadRequest): Promise<DownloadedAttachments>;
export async function downloadAttachments(c: MailSource, req: DownloadRequest): Promise<DownloadedAttachments> {
  const folder = await Folders.resolveIn(c, req.folder);
  const files = await withMailbox(c, folder, { readOnly: true }, async () => {
    const m = await c.fetchOne(String(req.uid), { uid: true, bodyStructure: true }, { uid: true });
    if (!m || !m.bodyStructure) throw noMessage(req.folder, req.uid);
    const { leaves } = classifyParts(m.bodyStructure);
    const wanted = req.parts === "all" ? [...leaves.keys()] : req.parts;
    const nodes = wanted.map((part) => {
      const node = leaves.get(part);
      if (!node) {
        throw new ToolError(`Part "${part}" is not an attachment of message ${req.uid}. Use a part id from read_message's attachments list.`);
      }
      const declared = decodedSize(node);
      if (declared !== null && declared > req.maxBytes) throw tooBig(declared, req.maxBytes);
      return { part, node };
    });
    const out: AttachmentFile[] = [];
    for (const { part, node } of nodes) {
      out.push({
        part,
        filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? null,
        mimeType: node.type.toLowerCase(),
        charset: node.parameters?.charset,
        bytes: await readCapped(c, req, part, node),
      });
    }
    return out;
  });
  return { folder, uid: req.uid, files };
}

async function readCapped(c: MailSource, req: DownloadRequest, part: string, node: MessageStructureObject): Promise<Uint8Array> {
  const dl = await c.download(String(req.uid), part, { uid: true, maxBytes: req.maxBytes + 1, chunkSize: DOWNLOAD_CHUNK_BYTES });
  if (!dl.content) throw noMessage(req.folder, req.uid);
  let buf = new Uint8Array(decodedSize(node) ?? 64 * 1024);
  let total = 0;
  for await (const chunk of dl.content as AsyncIterable<Uint8Array>) {
    if (total + chunk.length > req.maxBytes) {
      (dl.content as { destroy?: () => void }).destroy?.();
      throw tooBig(total + chunk.length, req.maxBytes);
    }
    if (total + chunk.length > buf.length) {
      const grown = new Uint8Array(Math.max(total + chunk.length, buf.length * 2));
      grown.set(buf.subarray(0, total));
      buf = grown;
    }
    buf.set(chunk, total);
    total += chunk.length;
  }
  return buf.subarray(0, total);
}

export type AttachmentPayload =
  | { kind: "text"; filename: string | null; mimeType: string; size: number; text: string; truncated: boolean }
  | { kind: "pdf-text"; filename: string | null; mimeType: string; size: number; pages: number; text: string; truncated: boolean }
  | { kind: "image"; filename: string | null; mimeType: string; size: number; base64: string }
  | { kind: "blob"; filename: string | null; mimeType: string; size: number; base64: string };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function isTextual(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "image/svg+xml" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

function decodeText(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** How a model reads a file it cannot open itself: images as images, text and PDFs as text, anything else as bytes. */
export async function toPayload(file: AttachmentFile, opts: { format: "auto" | "raw"; maxChars: number }): Promise<AttachmentPayload> {
  const { filename, mimeType, bytes } = file;
  const size = bytes.length;
  const blob = (): AttachmentPayload => ({ kind: "blob", filename, mimeType, size, base64: base64(bytes) });

  if (opts.format === "raw") return blob();
  if (IMAGE_TYPES.has(mimeType)) return { kind: "image", filename, mimeType, size, base64: base64(bytes) };
  if (isTextual(mimeType)) {
    const raw = decodeText(bytes, file.charset);
    return { kind: "text", filename, mimeType, size, ...clip(mimeType === "text/html" ? htmlToText(raw) : raw, opts.maxChars) };
  }
  if (mimeType === "application/pdf") {
    const { getDocumentProxy, extractText } = await import("unpdf");
    let extracted: { totalPages: number; text: string };
    try {
      // pdf.js may detach the buffer it is given; hand it a copy so the blob fallback still has the bytes.
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      if (pdf.numPages > MAX_PDF_PAGES) {
        throw new ToolError(`This PDF has ${pdf.numPages} pages. Text extraction stops at ${MAX_PDF_PAGES}. Use format "raw" to get the file itself.`);
      }
      extracted = await extractText(pdf, { mergePages: true });
    } catch (e) {
      if (e instanceof ToolError) throw e;
      return blob(); // encrypted or malformed: pdf.js cannot read it, so hand over the file
    }
    const { totalPages, text } = extracted;
    if (!text.trim()) return blob();
    return { kind: "pdf-text", filename, mimeType, size, pages: totalPages, ...clip(text.trim(), opts.maxChars) };
  }
  return blob();
}
