import type { ImapFlow } from "imapflow";
import { ToolError } from "./errors";
import { Folders } from "./folders";
import { withMailbox } from "./imap";

type OrganizeClient = Pick<
  ImapFlow,
  "getMailboxLock" | "messageFlagsAdd" | "messageFlagsRemove" | "messageMove" | "search" | "capabilities" | "list"
>;

interface MarkRequest {
  folder: string;
  uids: readonly number[];
  read?: boolean;
  flagged?: boolean;
}

interface MarkResult {
  folder: string;
  updated: number[];
  missing: number[];
}

async function present(c: OrganizeClient, uids: readonly number[]): Promise<{ found: number[]; missing: number[] }> {
  const hit = new Set((await c.search({ uid: uids.join(",") }, { uid: true })) || []);
  return { found: uids.filter((u) => hit.has(u)), missing: uids.filter((u) => !hit.has(u)) };
}

export async function markMessages(c: OrganizeClient, req: MarkRequest): Promise<MarkResult> {
  const folders = await Folders.load(c);
  const folder = folders.resolve(req.folder);
  return withMailbox(c, folder, {}, async () => {
    const { found, missing } = await present(c, req.uids);
    if (found.length) {
      const range = found.join(",");
      const apply = async (on: boolean | undefined, flag: string) => {
        if (on === undefined) return;
        const ok = on ? await c.messageFlagsAdd(range, [flag], { uid: true }) : await c.messageFlagsRemove(range, [flag], { uid: true });
        if (!ok) throw new ToolError(`The server refused to change ${flag} on those messages.`);
      };
      await apply(req.read, "\\Seen");
      await apply(req.flagged, "\\Flagged");
    }
    return { folder, updated: found, missing };
  });
}

interface MoveRequest {
  folder: string;
  uids: readonly number[];
  to: string;
}

interface MoveResult {
  destination: string;
  /** `to` is null when the server sends no COPYUID. */
  moved: { from: number; to: number | null }[];
  missing: number[];
}

// Without MOVE, imapflow emulates it with COPY + messageDelete, which without UIDPLUS is a plain EXPUNGE
// that purges every \Deleted message in the source folder.
function assertSafeMove(c: OrganizeClient): void {
  if (!c.capabilities.get("MOVE") && !c.capabilities.get("UIDPLUS")) {
    throw new ToolError("This mail server supports neither MOVE nor UIDPLUS, so moving mail could delete unrelated messages. The move was refused.");
  }
}

export async function moveMessages(c: OrganizeClient, req: MoveRequest): Promise<MoveResult> {
  const folders = await Folders.load(c);
  const source = folders.resolve(req.folder);
  const dest = folders.resolve(req.to);
  if (source === dest) throw new ToolError(`Messages are already in "${dest}".`);
  const destRole = folders.roleOf(dest);
  if (destRole === "drafts" || destRole === "sent") {
    throw new ToolError(`Messages cannot be moved into ${destRole}. Drafts is the send queue, and only send_draft writes to Sent.`);
  }
  assertSafeMove(c);

  return withMailbox(c, source, {}, async () => {
    const { found, missing } = await present(c, req.uids);
    if (found.length === 0) return { destination: dest, moved: [], missing };
    const r = await c.messageMove(found.join(","), dest, { uid: true });
    if (!r) throw new ToolError(`The server could not move those messages to "${dest}". They may now exist in both folders; run search_messages to check.`);
    return { destination: dest, moved: found.map((from) => ({ from, to: r.uidMap?.get(from) ?? null })), missing };
  });
}
