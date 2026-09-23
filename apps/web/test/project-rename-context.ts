import { SessionChannelProjectionAuthority } from "../src/lib/session-pins";
import type { AppContextValue } from "../src/context";
import type { OpenGeniClient } from "@opengeni/sdk";

export const workspaceId = "11111111-1111-4111-8111-111111111111";
let project = {
  id: "project-qa",
  workspaceId,
  name: "Website redesign",
  pinned: false,
  position: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};
export const evidence = { calls: [] as unknown[], fail: false, delay: 0 };
export const client = {
  getSession: async () => null,
  streamEvents: async function* () {},
  getSessionLineage: async () => ({ ancestors: [], descendants: [] }),
  listChannels: async () => [{ ...project }],
  listSessionPage: async () => ({ sessions: [], pinned: [], nextCursor: null }),
  updateChannel: async (workspace: string, id: string, request: { name: string }) => {
    evidence.calls.push({ workspace, id, request });
    if (evidence.delay) await new Promise((resolve) => setTimeout(resolve, evidence.delay));
    if (evidence.fail) throw new Error("A project with this name already exists");
    project = { ...project, ...request };
    return { ...project };
  },
} as unknown as OpenGeniClient;
const context = {
  client,
  session: null,
  accessContext: { subjectId: "rename-qa" },
  sessionChannelProjectionAuthority: new SessionChannelProjectionAuthority(),
  setSession: () => {},
  resetSessionView: () => {},
} as unknown as AppContextValue;
export const useAppContext = () => context;
export const useRail = () => ({ workspaceId, setDrawerOpen: () => {} });
