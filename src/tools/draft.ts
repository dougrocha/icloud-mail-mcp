import { z } from "zod";
import { deleteDraft, saveDraft, type SaveDraftRequest } from "../mail/drafts";
import { MAX_RECIPIENTS } from "../mail/mime";
import { defineTool, hints, result, toolset } from "./define";

const addresses = z.array(z.string()).max(MAX_RECIPIENTS).describe('Addresses as "a@b.com" or "Name <a@b.com>"');

const saveDraftTool = defineTool({
  name: "save_draft",
  description:
    "Create or edit a plain-text email draft in the Drafts folder. Nothing is sent. " +
    "To create, omit `replaceUid` and give `to`, `subject` and `body`. To reply or forward, pass `original` {folder, uid, mode: reply|replyAll|forward}. " +
    "The recipients, \"Re:\" or \"Fwd:\" subject, threading headers and quoted original are then filled in, and anything you pass overrides them. " +
    "A forward has no recipients until you give `to`, and the original's attachments are not forwarded. " +
    "To edit, pass `replaceUid` (a draft this tool created). Fields you omit keep their current value. `body` replaces your text and keeps the quoted original. " +
    "Pass quote:false to drop it. Every save returns a NEW uid, so always use the latest one. " +
    "Drafts written in Apple Mail cannot be edited here, so create a new one instead. " +
    "A draft holds at most 25 recipients in total. The result is the full draft (from, to, cc, bcc, subject, body, quotedOriginal). Show it to the user before anything is sent.",
  input: z
    .object({
      replaceUid: z.number().int().positive().optional().describe("uid of the draft to edit (from a previous save_draft)"),
      original: z
        .object({
          folder: z.string().default("INBOX").describe("Folder of the message being answered"),
          uid: z.number().int().positive(),
          mode: z.enum(["reply", "replyAll", "forward"]),
        })
        .optional()
        .describe("Message to reply to or forward. Use only when creating a draft."),
      to: addresses.optional().describe("Replaces the current To list"),
      cc: addresses.optional(),
      bcc: addresses.optional(),
      subject: z.string().max(900).optional(),
      body: z.string().max(200_000).optional().describe("Plain text. For a reply or forward, the quoted original is appended below it."),
      quote: z.boolean().optional().describe("For a reply or forward, include the original below your text (default true). When editing, false removes the quote."),
    })
    .refine((a) => !(a.replaceUid && a.original), "Pass replaceUid to edit a draft or original to start a reply or forward, not both"),
  annotations: hints.additiveWrite,
  run: async (a, io) => {
    const fields = { to: a.to, cc: a.cc, bcc: a.bcc, subject: a.subject, body: a.body };
    const req: SaveDraftRequest =
      a.replaceUid !== undefined
        ? { mode: "update", replaceUid: a.replaceUid, fields, quote: a.quote }
        : { mode: "create", fields, origin: a.original ? { kind: a.original.mode, folder: a.original.folder, uid: a.original.uid } : { kind: "new" }, quote: a.quote ?? true };
    return result.json(await io.imap((c) => saveDraft(c, io.account, req)));
  },
});

const deleteDraftTool = defineTool({
  name: "delete_draft",
  description: "Permanently delete a draft that save_draft created. This cannot delete received or sent mail, or drafts written in Apple Mail.",
  input: z.object({ uid: z.number().int().positive().describe("uid in the Drafts folder") }),
  annotations: hints.destructive,
  run: async ({ uid }, io) => result.json(await io.imap((c) => deleteDraft(c, uid))),
});

export const draftTools = toolset("draft", [saveDraftTool, deleteDraftTool]);
