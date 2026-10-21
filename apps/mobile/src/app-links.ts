export {
  accountForAppLink,
  appHandoffUrl,
  parseAppLink,
  type AppLink,
} from "@opengeni/sdk/app-links";

/** The app route for a session, in its own workspace so the screen below keeps its own. */
export function appSessionPath(sessionId: string, workspaceId: string, at: number | null): string {
  const query = [`workspace=${encodeURIComponent(workspaceId)}`];
  if (at) query.push(`at=${at}`);
  return `/session/${encodeURIComponent(sessionId)}?${query.join("&")}`;
}
