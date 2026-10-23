// What the Mac app does for its page beyond this computer: the Dock badge and
// native notifications (see desktop/ipc.ts). Null in the browser dev build.

export type AppHost = {
  setAttention(count: number): void;
  notify(notification: { title: string; body: string; agentId: string }): void;
  onOpenAgent(listener: (agentId: string) => void): () => void;
  /** Back to the sign-in window. */
  signInAgain(): void;
};

export const appHost: AppHost | null =
  typeof window === "undefined"
    ? null
    : ((window as unknown as { opengeniSimple?: { app?: AppHost } }).opengeniSimple?.app ?? null);
