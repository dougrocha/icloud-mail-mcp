import { z } from "zod";
import { MAX_ATTACHMENT_BYTES, PART_ID, downloadAttachments, toPayload, type AttachmentPayload } from "../mail/attachments";
import { defineTool, hints, toolset, type ToolResult } from "./define";

const getAttachmentTool = defineTool({
  name: "get_attachment",
  description:
    `Download one attachment (max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB) using the \`part\` id from read_message. Images come back as images, text files as text, ` +
    "PDFs as extracted text (so you can read an invoice), anything else as a base64 resource. Use format \"raw\" to get the file bytes instead. " +
    "Does not mark the message as read. " +
    "If you can run shell commands on the owner's Mac, prefer `icloud-mail-attachment <folder> <uid> <part>` for PDFs and large files. " +
    "It saves the file locally (up to 50 MB) and prints its path, which you can then open with your own file reader.",
  input: z.object({
    folder: z.string().default("INBOX"),
    uid: z.number().int().positive(),
    part: z.string().regex(PART_ID).describe('Attachment part id from read_message, e.g. "2" or "1.2"'),
    format: z.enum(["auto", "raw"]).default("auto"),
    maxChars: z.number().int().min(500).max(200_000).default(50_000).describe("Truncate extracted text after this many characters"),
  }),
  annotations: hints.readOnly,
  run: async ({ folder, uid, part, format, maxChars }, io) => {
    const {
      files: [file],
    } = await io.imap((c) => downloadAttachments(c, { folder, uid, parts: [part], maxBytes: MAX_ATTACHMENT_BYTES }));
    // The connection is closed by now, so PDF extraction does not hold the IMAP socket open.
    return { content: toToolContent(await toPayload(file, { format, maxChars }), { folder, uid, part }) };
  },
});

function toToolContent(p: AttachmentPayload, ref: { folder: string; uid: number; part: string }): NonNullable<ToolResult["content"]> {
  const meta = {
    filename: p.filename,
    mimeType: p.mimeType,
    size: p.size,
    ...(p.kind === "pdf-text" ? { pages: p.pages } : {}),
    ...(p.kind === "text" || p.kind === "pdf-text" ? { truncated: p.truncated } : {}),
  };
  const head = { type: "text" as const, text: JSON.stringify(meta) };
  switch (p.kind) {
    case "text":
    case "pdf-text":
      return [head, { type: "text", text: p.text }];
    case "image":
      return [head, { type: "image", data: p.base64, mimeType: p.mimeType }];
    case "blob":
      return [
        head,
        { type: "resource", resource: { uri: `mail://${encodeURIComponent(ref.folder)}/${ref.uid}/${ref.part}`, mimeType: p.mimeType, blob: p.base64 } },
      ];
  }
}

export const attachmentTools = toolset("attachments", [getAttachmentTool]);
