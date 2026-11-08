import { expect, test } from "bun:test";
import {
  OpenGeniClient,
  type ChatSession,
  type Session,
  type SessionLineageResponse,
} from "@opengeni/sdk";
import { useSession, type UseSessionResult } from "../src/hooks/use-session";
import { useSessionLineage, type UseSessionLineageResult } from "../src/hooks/use-session-lineage";
import {
  useWorkspaceSessions,
  type UseWorkspaceSessionsResult,
} from "../src/hooks/use-workspace-sessions";
import { useChannels, type UseChannelsResult } from "../src/hooks/use-channels";
import { OpenGeniProvider } from "../src/provider";
import { SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { registerDom, renderHook, flush } from "./render-hook";

registerDom();

for (const viaProvider of [false, true]) {
  for (const compact of [false, true]) {
    test(`session hook preserves ${compact ? "explicit compact" : "default full"} client ${viaProvider ? "through provider" : "override"}`, async () => {
      const accepts: string[] = [];
      const base = new OpenGeniClient({
        baseUrl: "https://api.test",
        fetch: async (input, init) => {
          const accept = new Headers(init?.headers).get("accept")!;
          if (String(input).includes(`/sessions/${SESSION_ID}`)) accepts.push(accept);
          return Response.json({
            id: SESSION_ID,
            workspaceId: WORKSPACE_ID,
            lastSequence: 0,
            ...(accept.includes("opengeni-session=chat")
              ? {}
              : {
                  instructions: "Operator configuration",
                  skills: [],
                  effectiveTools: [],
                }),
          });
        },
      });
      const client = compact ? base.withSessionResponse("chat") : base;
      // Keep provider background work local; the session read uses the real SDK.
      client.getWorkspace = async () => ({ inferenceControl: { revision: 0 } }) as never;
      client.streamWorkspaceLiveEvents = (_workspaceId, options) =>
        (async function* () {
          if (!options?.signal?.aborted)
            await new Promise<void>((resolve) => {
              options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          yield* [];
        })();
      const rendered = await renderHook(
        () =>
          useSession(SESSION_ID, {
            events: [],
            ...(viaProvider ? {} : { client, workspaceId: WORKSPACE_ID }),
          }),
        undefined,
        viaProvider
          ? {
              wrapper: ({ children }) => (
                <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
                  {children}
                </OpenGeniProvider>
              ),
            }
          : {},
      );
      try {
        await flush();
        expect(rendered.result.current.error).toBeNull();
        expect(rendered.result.current.session?.id).toBe(SESSION_ID);
        expect(rendered.result.current.session?.instructions).toBe(
          compact ? undefined : "Operator configuration",
        );
        expect(rendered.result.current.session?.skills).toEqual(compact ? undefined : []);
        expect(accepts).toEqual([
          compact ? "application/json; opengeni-session=chat" : "application/json",
        ]);
      } finally {
        await rendered.unmount();
      }
    });
  }
}

// Compiled, not executed: public hooks retain their historical full defaults,
// while a compact client explicitly selects the compact result type.
function publicHookTypes(full: OpenGeniClient) {
  const compact = full.withSessionResponse("chat");
  const fullOptions = { client: full, workspaceId: WORKSPACE_ID, events: [] };
  const compactOptions = { ...fullOptions, client: compact };
  const fullDetail: Session | null = useSession(SESSION_ID, fullOptions).session;
  const defaultDetail: Session | null = useSession(SESSION_ID).session;
  const fullList: Session[] = useWorkspaceSessions(fullOptions).sessions;
  const defaultList: Session[] = useWorkspaceSessions().sessions;
  const fullLineage: SessionLineageResponse | null = useSessionLineage(
    SESSION_ID,
    fullOptions,
  ).lineage;
  const fullMove: Promise<Session | null> = useChannels(fullOptions).moveSession(SESSION_ID, null);
  const compactDetail: ChatSession | null = useSession(SESSION_ID, compactOptions).session;
  // @ts-expect-error Compact callers cannot assume operator configuration is present.
  const notFull: Session | null = useSession(SESSION_ID, compactOptions).session;
  const compactList: ChatSession[] = useWorkspaceSessions(compactOptions).sessions;
  // @ts-expect-error Compact list results are not full sessions.
  const notFullList: Session[] = useWorkspaceSessions(compactOptions).sessions;
  const aliases: [
    UseSessionResult["session"],
    UseWorkspaceSessionsResult["sessions"],
    UseSessionLineageResult["lineage"],
    ReturnType<UseChannelsResult["moveSession"]>,
  ] = [fullDetail, fullList, fullLineage, fullMove];
  return { defaultDetail, defaultList, compactDetail, compactList, notFull, notFullList, aliases };
}

test("public hook response contracts are checked by TypeScript", () => {
  expect(typeof publicHookTypes).toBe("function");
});
