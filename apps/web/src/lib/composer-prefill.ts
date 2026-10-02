/**
 * One-shot hand-offs to the new-chat composer from a page that sends the
 * person there. Kept in memory only: a reload drops them, which is right for
 * a suggestion or a click that already happened.
 *
 * - A prefill (Get started's first tasks): the new-chat page takes it once its
 *   saved draft has loaded, so the draft can't overwrite it, and the person
 *   still presses Send.
 * - A send (first run starting a chat the person asked
 *   for): the page sends what its composer holds (the saved draft, or a
 *   prefill) as soon as it can, once. If it can't (no model, say), the message
 *   stays in the composer for the person to send.
 */
let pending: { workspaceId: string; text: string } | null = null;
let pendingSend: string | null = null;

export function queueComposerPrefill(workspaceId: string, text: string): void {
  pending = { workspaceId, text };
}

export function takeComposerPrefill(workspaceId: string): string | null {
  if (!pending || pending.workspaceId !== workspaceId) return null;
  const { text } = pending;
  pending = null;
  return text;
}

export function hasComposerPrefill(workspaceId: string): boolean {
  return pending?.workspaceId === workspaceId;
}

export function queueComposerSend(workspaceId: string): void {
  pendingSend = workspaceId;
}

export function takeComposerSend(workspaceId: string): boolean {
  if (pendingSend !== workspaceId) return false;
  pendingSend = null;
  return true;
}
