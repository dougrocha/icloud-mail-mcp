import { z } from "zod";
import { listFolders, readMessage, searchMessages } from "../mail/imap";
import { defineTool, hints, result, toolset } from "./define";

const listFoldersTool = defineTool({
  name: "list_folders",
  description:
    "List iCloud Mail folders with message and unread counts. `role` marks the real inbox/drafts/sent/trash/junk/archive " +
    "folders (iCloud also has empty legacy duplicates, so use the one with a role). Anywhere a `folder` is asked for, you " +
    "can pass a role name (inbox, drafts, sent, archive, trash, junk) or an exact path.",
  input: z.object({}),
  annotations: hints.readOnly,
  run: async (_args, io) => result.json(await io.imap(listFolders)),
});

const searchMessagesTool = defineTool({
  name: "search_messages",
  description:
    "Search a folder (default INBOX) and return the newest matching message headers. All filters are optional and " +
    "combined with AND. Use the returned uid with read_message. To find drafts, search folder \"drafts\".",
  input: z.object({
    folder: z.string().default("INBOX").describe("Folder path from list_folders, or a role: inbox, drafts, sent, archive, trash, junk"),
    from: z.string().optional().describe("Substring of the From address/name"),
    to: z.string().optional(),
    subject: z.string().optional(),
    text: z.string().optional().describe("Matches headers and body"),
    since: z.iso.date().optional().describe("Date as YYYY-MM-DD, inclusive (e.g. 2026-11-01)"),
    before: z.iso.date().optional().describe("Date as YYYY-MM-DD, exclusive"),
    unreadOnly: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  annotations: hints.readOnly,
  run: async (args, io) => result.json(await io.imap((c) => searchMessages(c, args))),
});

const readMessageTool = defineTool({
  name: "read_message",
  description:
    "Read one message by uid: headers, plain-text body, and attachment list. Does not mark it as read. " +
    "Each attachment has a `part` id for get_attachment. Also works on drafts (folder \"drafts\") to review one before sending. " +
    "A message is identified by (folder, uid).",
  input: z.object({
    folder: z.string().default("INBOX"),
    uid: z.number().int().positive(),
    maxChars: z.number().int().min(500).max(100_000).default(20_000).describe("Truncate the body after this many characters"),
  }),
  annotations: hints.readOnly,
  run: async ({ folder, uid, maxChars }, io) => result.json(await io.imap((c) => readMessage(c, folder, uid, maxChars))),
});

export const readTools = toolset("read", [listFoldersTool, searchMessagesTool, readMessageTool]);
