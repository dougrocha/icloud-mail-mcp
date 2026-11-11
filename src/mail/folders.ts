import type { ImapFlow, ListResponse } from "imapflow";
import { ToolError } from "./errors";

export type FolderRole = "inbox" | "drafts" | "sent" | "trash" | "junk" | "archive";

const ROLES: readonly FolderRole[] = ["inbox", "drafts", "sent", "trash", "junk", "archive"];
const isRole = (s: string): s is FolderRole => (ROLES as readonly string[]).includes(s);
const USE_TO_ROLE: Readonly<Record<string, FolderRole>> = {
  "\\drafts": "drafts",
  "\\sent": "sent",
  "\\trash": "trash",
  "\\junk": "junk",
  "\\archive": "archive",
};

/**
 * iCloud declares the real folders with raw LIST flags (\\Sent on "Sent Messages", \\Trash on "Deleted Messages")
 * but does not advertise SPECIAL-USE, so imapflow ignores them and name-guesses the EMPTY legacy duplicates
 * ("Sent Items", "Deleted Items") instead. The raw flags are the only trustworthy signal.
 */
export function declaredUse(flags: ReadonlySet<string>): string | undefined {
  return [...flags].find((f) => USE_TO_ROLE[f.toLowerCase()]);
}

const sourceRank = (s: string | undefined) => (s === "user" || s === "extension" ? 1 : 2);

export class Folders {
  private constructor(
    private readonly byRole: ReadonlyMap<FolderRole, string>,
    private readonly paths: ReadonlySet<string>,
  ) {}

  static async load(c: Pick<ImapFlow, "list">): Promise<Folders> {
    return Folders.fromListing(await c.list());
  }

  static fromListing(boxes: readonly ListResponse[]): Folders {
    const best = new Map<FolderRole, { path: string; rank: number }>();
    for (const b of boxes) {
      const declared = declaredUse(b.flags);
      const role: FolderRole | undefined =
        b.path.toUpperCase() === "INBOX"
          ? "inbox"
          : USE_TO_ROLE[(declared ?? b.specialUse ?? "").toLowerCase()];
      if (!role) continue;
      const cand = { path: b.path, rank: role === "inbox" || declared ? 0 : sourceRank(b.specialUseSource) };
      const cur = best.get(role);
      if (!cur || cand.rank < cur.rank || (cand.rank === cur.rank && cand.path < cur.path)) best.set(role, cand);
    }
    return new Folders(
      new Map([...best].map(([r, v]) => [r, v.path])),
      new Set(boxes.map((b) => b.path)),
    );
  }

  path(role: FolderRole): string {
    const p = this.byRole.get(role);
    if (!p) throw new ToolError(`This account has no ${role} folder. Run list_folders to see what exists.`);
    return p;
  }

  roleOf(path: string): FolderRole | null {
    for (const [r, p] of this.byRole) if (p === path) return r;
    return null;
  }

  static async resolveIn(c: Pick<ImapFlow, "list">, input: string): Promise<string> {
    if (input === "INBOX") return input;
    return (await Folders.load(c)).resolve(input);
  }

  resolve(input: string): string {
    const path = this.lookup(input);
    if (isAppleNotesPath(path)) throw new ToolError(`"${path}" holds Apple Notes, not mail. This server does not open it.`);
    return path;
  }

  private lookup(input: string): string {
    if (this.paths.has(input)) return input;
    const kw = input.trim().toLowerCase();
    if (isRole(kw)) return this.path(kw);
    throw new ToolError(
      `No folder "${input}". Use one of: ${ROLES.join(", ")}, or an exact path: ${[...this.paths].join(", ")}.`,
    );
  }
}

const isAppleNotesPath = (path: string) => /^notes(\/|$)/i.test(path);
