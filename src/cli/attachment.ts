#!/usr/bin/env bun
/**
 *   icloud-mail-attachment <folder> <uid> [part...]
 *
 * Saves the attachments of one message (all of them, or the part ids read_message lists) to
 * ~/Downloads/icloud-mail and prints each path. Read-only: the folder opens with EXAMINE.
 * Logs in with ICLOUD_USER and ICLOUD_APP_PASSWORD from the environment or this repo's .dev.vars.
 *
 * Runs under plain Bun, so it must never import cloudflare:*, directly or through another module.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { PART_ID, downloadAttachments } from "../mail/attachments";
import { errorMessage } from "../mail/errors";
import { imapRunner } from "../mail/imap";
import { saveAttachment } from "./files";

const MAX_BYTES = 50 * 1024 * 1024;
const USAGE = "usage: icloud-mail-attachment <folder> <uid> [part...]";

/** KEY=VALUE lines, optionally quoted. Nothing is expanded, unlike `bun --env-file`, which turns "pa$$word" into "pa$". */
export function parseDevVars(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return vars;
}

function devVars(): Record<string, string> {
  try {
    return parseDevVars(readFileSync(fileURLToPath(new URL("../../.dev.vars", import.meta.url)), "utf8"));
  } catch {
    return {};
  }
}

async function main(args: string[]): Promise<number> {
  const [folder, uidRaw, ...parts] = args;
  const uid = Number(uidRaw);
  if (!folder || !Number.isSafeInteger(uid) || uid <= 0 || !parts.every((p) => PART_ID.test(p))) {
    console.error(USAGE);
    return 2;
  }
  const vars = { ...devVars(), ...process.env };
  if (!vars.ICLOUD_USER || !vars.ICLOUD_APP_PASSWORD) {
    console.error("Set ICLOUD_USER and ICLOUD_APP_PASSWORD in this repo's .dev.vars.");
    return 2;
  }
  try {
    const imap = imapRunner({ user: vars.ICLOUD_USER, pass: vars.ICLOUD_APP_PASSWORD }, "node-tls");
    const wanted = parts.length ? (parts as [string, ...string[]]) : "all";
    const got = await imap((c) => downloadAttachments(c, { folder, uid, parts: wanted, maxBytes: MAX_BYTES }));
    if (got.files.length === 0) {
      console.error(`Message ${uid} in ${got.folder} has no attachments.`);
      return 1;
    }
    const out = join(homedir(), "Downloads", "icloud-mail");
    for (const f of got.files) console.log(await saveAttachment(out, got.folder, uid, f));
    return 0;
  } catch (e) {
    console.error(errorMessage(e));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
