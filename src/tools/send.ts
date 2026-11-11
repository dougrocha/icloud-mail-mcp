import { z } from "zod";
import { sendDraft } from "../mail/sending";
import { defineTool, hints, result, toolset } from "./define";

const sendDraftTool = defineTool({
  name: "send_draft",
  description:
    "Send an existing draft from the Drafts folder exactly as saved. It delivers the email and cannot be undone. " +
    "Only call it after the user has seen the full draft (the save_draft result, or read_message with folder \"drafts\") and explicitly asked to send it. " +
    "It cannot send anything that is not a saved draft. On success the message is filed in Sent and the draft is removed. " +
    "If the result says the send state is unknown, do NOT retry. Check the Sent folder first.",
  input: z.object({ uid: z.number().int().positive().describe("uid of the draft in the Drafts folder (the latest one from save_draft)") }),
  annotations: hints.outbound,
  run: async ({ uid }, io) => result.json(await io.imap((c) => sendDraft(c, io.account, io.sendLimiter, uid))),
});

export const sendTools = toolset("send", [sendDraftTool]);
