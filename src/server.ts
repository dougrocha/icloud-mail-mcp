import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import { connect } from "cloudflare:sockets";
import { env } from "cloudflare:workers";
import { createSocketsTransport, type SocketsConnect } from "imapflow";
import { CAPABILITY_IDS, Grant } from "./capabilities";
import { imapRunner } from "./mail/imap";
import { TOOLSETS } from "./tools";
import type { ToolIO } from "./tools/define";

function buildIO(): ToolIO {
  const creds = { user: env.ICLOUD_USER, pass: env.ICLOUD_APP_PASSWORD };
  return {
    imap: imapRunner(creds, createSocketsTransport(connect as SocketsConnect)),
    account: creds,
    sendLimiter: env.SEND_LIMITER,
  };
}

function instructionsFor(grant: Grant): string {
  const granted = grant.capabilities;
  const denied = CAPABILITY_IDS.filter((c) => !grant.has(c));
  const lines = [
    `Permissions granted: ${granted.join(", ") || "none"}.` +
      (denied.length ? ` Not granted: ${denied.join(", ")} (the user can disconnect and reconnect this connector to grant more).` : ""),
    "A `folder` argument takes an exact path from list_folders or a role: inbox, drafts, sent, archive, trash, junk.",
    "A message is identified by (folder, uid). uids change when a message is moved and on every save_draft.",
  ];
  if (grant.has("send")) {
    lines.push("To send, call save_draft, show the user the full draft, and call send_draft only after they explicitly confirm.");
  }
  return lines.join("\n");
}

export function createServer(ctx: McpRequestContext): McpServer {
  // createMcpHandler calls this once per HTTP request; authInfo.scopes are the verified token's scopes.
  const grant = Grant.fromScopes(ctx.authInfo?.scopes);
  const server = new McpServer({ name: "icloud-mail", version: "0.2.0" }, { instructions: instructionsFor(grant) });
  const io = buildIO();
  for (const set of Object.values(TOOLSETS)) {
    if (!grant.has(set.capability)) continue;
    for (const tool of set.tools) tool.attach(server, io);
  }
  return server;
}
