import type { PendingPrompt } from "@opengeni/react/session";

// UI-only handoff across the new-chat route. Never persist or resend this text;
// the server receipt remains the sole authority for the accepted message.
const prompts = new WeakMap<object, Map<string, PendingPrompt>>();
const key = (workspaceId: string, sessionId: string) => `${workspaceId}:${sessionId}`;

export function rememberPendingPrompt(
  client: object,
  workspaceId: string,
  sessionId: string,
  prompt: PendingPrompt,
) {
  let entries = prompts.get(client);
  if (!entries) prompts.set(client, (entries = new Map()));
  if (entries.size >= 20) entries.delete(entries.keys().next().value!);
  entries.set(key(workspaceId, sessionId), prompt);
}

export function readPendingPrompt(client: object, workspaceId: string, sessionId: string) {
  return prompts.get(client)?.get(key(workspaceId, sessionId)) ?? null;
}

export function forgetPendingPrompt(client: object, workspaceId: string, sessionId: string) {
  prompts.get(client)?.delete(key(workspaceId, sessionId));
}
