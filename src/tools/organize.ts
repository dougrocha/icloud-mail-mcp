import { z } from "zod";
import { markMessages, moveMessages } from "../mail/organize";
import { defineTool, hints, result, toolset } from "./define";

const uids = z.array(z.number().int().positive()).min(1).max(100).describe("Message uids in `folder` (max 100)");
const folder = z.string().default("INBOX").describe("Folder path or role (inbox, drafts, sent, archive, trash, junk)");

const markMessagesTool = defineTool({
  name: "mark_messages",
  description:
    "Mark messages read/unread and/or flagged/unflagged. Pass only the fields you want to change: " +
    "`read: true|false`, `flagged: true|false`. Safe to repeat. The result lists uids that no longer exist as missing.",
  input: z
    .object({ folder, uids, read: z.boolean().optional(), flagged: z.boolean().optional() })
    .refine((a) => a.read !== undefined || a.flagged !== undefined, "Pass `read`, `flagged`, or both"),
  annotations: hints.idempotentWrite,
  run: async (a, io) =>
    result.json(
      await io.imap((c) =>
        markMessages(c, { folder: a.folder, uids: a.uids, read: a.read, flagged: a.flagged }),
      ),
    ),
});

const moveMessagesTool = defineTool({
  name: "move_messages",
  description:
    "Move messages to another folder. `to` is \"archive\", \"trash\", \"junk\" or \"inbox\" (the account's real folders), " +
    "or an exact folder path from list_folders. Messages in Trash can be recovered, and nothing here deletes permanently. " +
    "Cannot move into drafts or sent. uids change after a move, and the result maps each old uid to its new one.",
  input: z.object({ folder: folder.describe("Source folder"), uids, to: z.string() }),
  annotations: hints.idempotentWrite,
  run: async (a, io) => result.json(await io.imap((c) => moveMessages(c, { folder: a.folder, uids: a.uids, to: a.to }))),
});

export const organizeTools = toolset("organize", [markMessagesTool, moveMessagesTool]);
