import type { Capability } from "../capabilities";
import type { Toolset } from "./define";
import { attachmentTools } from "./attachments";
import { draftTools } from "./draft";
import { organizeTools } from "./organize";
import { readTools } from "./read";
import { sendTools } from "./send";

export const TOOLSETS = {
  read: readTools,
  draft: draftTools,
  send: sendTools,
  organize: organizeTools,
  attachments: attachmentTools,
} as const satisfies { readonly [C in Capability]: Toolset<C> };
