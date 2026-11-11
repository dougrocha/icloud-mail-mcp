import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import type { ImapFlow } from "imapflow";
import type { z } from "zod";
import type { Capability } from "../capabilities";
import { ToolError, errorMessage } from "../mail/errors";
import type { Creds, ImapRunner } from "../mail/imap";
import type { RateLimiter } from "../mail/sending";

export interface ToolIO {
  readonly imap: ImapRunner;
  readonly account: Creds;
  readonly sendLimiter: RateLimiter;
}

export type ToolResult = CallToolResult;

export { ToolError };

export const result = {
  json: (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }),
  error: (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] }),
};

export const hints = {
  readOnly: { readOnlyHint: true, openWorldHint: true },
  idempotentWrite: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  additiveWrite: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  outbound: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
} as const satisfies Record<string, ToolAnnotations>;

interface ToolSpec<I extends z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly input: I;
  readonly annotations: ToolAnnotations;
  readonly run: (args: z.infer<I>, io: ToolIO) => Promise<ToolResult>;
}

interface ToolDef {
  attach(server: McpServer, io: ToolIO): void;
}


export function defineTool<I extends z.ZodType>(spec: ToolSpec<I>): ToolDef {
  return {
    attach(server, io) {
      server.registerTool(
        spec.name,
        { description: spec.description, inputSchema: spec.input as z.ZodType, annotations: spec.annotations },
        async (args: unknown): Promise<ToolResult> => {
          try {
            return await spec.run(args as z.infer<I>, io);
          } catch (e) {
            return result.error(e instanceof ToolError ? e.message : `Mail error: ${errorMessage(e)}`);
          }
        },
      );
    },
  };
}

export interface Toolset<C extends Capability> {
  readonly capability: C;
  readonly tools: readonly ToolDef[];
}

export const toolset = <C extends Capability>(capability: C, tools: readonly ToolDef[]): Toolset<C> => ({
  capability,
  tools,
});
