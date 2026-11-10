import { expect, test } from "bun:test";
import {
  OpenGeniClient,
  type ChatSession,
  type ChatClient,
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
import { OpenGeniProvider, type OpenGeniProviderProps } from "../src/provider";
import { createEmbeddedSessionClient } from "../src/embedded-session-client";
import type { SessionClientLike, EmbeddedSessionClientLike } from "../src/client";
import type { UseSessionOptions } from "../src/hooks/use-session";
import type { UseSessionLineageOptions } from "../src/hooks/use-session-lineage";
import type { UseWorkspaceSessionsOptions } from "../src/hooks/use-workspace-sessions";
import type { UseChannelsOptions } from "../src/hooks/use-channels";
import { useOpenGeni, useOpenGeniClient, type ClientOverride } from "../src/session-context";
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

// These wrappers intentionally annotate the exported public aliases rather
// than relying on inference from a concrete SDK client. They predate compact
// projections and must continue to compile without source edits.
function annotatedPublicContracts(
  options: UseSessionOptions,
  lineageOptions: UseSessionLineageOptions,
  channelsOptions: UseChannelsOptions,
  listOptions: UseWorkspaceSessionsOptions & { projection?: undefined },
  client: SessionClientLike,
  embedded: EmbeddedSessionClientLike,
  sdk: OpenGeniClient,
  override: ClientOverride,
  provider: OpenGeniProviderProps,
) {
  const detail: Session | null = useSession(SESSION_ID, options).session;
  const lineage: SessionLineageResponse | null = useSessionLineage(
    SESSION_ID,
    lineageOptions,
  ).lineage;
  const move: Promise<Session | null> = useChannels(channelsOptions).moveSession(SESSION_ID, null);
  const list: Session[] = useWorkspaceSessions(listOptions).sessions;
  const clientRead: Promise<Session> = client.getSession(WORKSPACE_ID, SESSION_ID);
  const providerRead: Promise<Session> = provider.client.getSession(WORKSPACE_ID, SESSION_ID);
  const embeddedRead: Promise<Session> = embedded.getSession(WORKSPACE_ID, SESSION_ID);
  const adapterRead: Promise<Session> = createEmbeddedSessionClient(sdk).getSession(
    WORKSPACE_ID,
    SESSION_ID,
  );
  const contextRead: Promise<Session> = useOpenGeni(override).client.getSession(
    WORKSPACE_ID,
    SESSION_ID,
  );
  const contextClientRead: Promise<Session> = useOpenGeniClient(override).getSession(
    WORKSPACE_ID,
    SESSION_ID,
  );
  const compactOptions: UseSessionOptions<ChatClient> = { client: sdk.withSessionResponse("chat") };
  const compactDetail: ChatSession | null = useSession(SESSION_ID, compactOptions).session;
  // @ts-expect-error Explicitly annotated compact options do not promise a full response.
  const notFull: Session | null = useSession(SESSION_ID, compactOptions).session;
  return {
    detail,
    lineage,
    move,
    list,
    clientRead,
    providerRead,
    embeddedRead,
    adapterRead,
    contextRead,
    contextClientRead,
    compactOptions,
    compactDetail,
    notFull,
  };
}

test("annotated exported options and clients retain their full response contracts", () => {
  expect(typeof annotatedPublicContracts).toBe("function");
});
