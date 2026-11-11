export class ToolError extends Error {}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const noMessage = (folder: string, uid: number) =>
  new ToolError(`No message with uid ${uid} in ${folder}. It may have been moved or deleted. Run search_messages again.`);
