import { describe, expect, test } from "bun:test";
import type { BrowserIdentity, BrowserRevision } from "@opengeni/sdk/interaction";
import { useBrowserIdentities } from "../src/hooks/use-browser-identities";
import { fakeClient, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IDENTITY_ID = "44444444-4444-4444-8444-444444444444";
const SECOND_IDENTITY_ID = "55555555-5555-4555-8555-555555555555";
const BROWSER_SESSION_ID = "66666666-6666-4666-8666-666666666666";
const REVISION_ID = "77777777-7777-4777-8777-777777777777";
const OPERATION_ID = "88888888-8888-4888-8888-888888888888";
const NOW = "2026-08-10T12:00:00.000Z";

describe("useBrowserIdentities", () => {
  test("lists profiles and routes explicit create, history, and publication mutations", async () => {
    const work = identity(IDENTITY_ID, "Work", NOW);
    const personal = identity(SECOND_IDENTITY_ID, "Personal", "2026-08-09T12:00:00.000Z");
    const saved = revision(work);
    const calls: Array<{ kind: string; request?: unknown }> = [];
    const client = fakeClient({
      listBrowserIdentities: async () => ({
        revision: 4,
        identities: [personal, work],
      }),
      createBrowserIdentity: async (_workspaceId, request) => {
        calls.push({ kind: "create", request });
        return {
          identity: identity(SECOND_IDENTITY_ID, request.name, "2026-08-11T12:00:00.000Z"),
          operationId: request.operationId,
          replayed: false,
        };
      },
      updateBrowserIdentity: async (_workspaceId, identityId, request) => {
        calls.push({ kind: "update", request: { identityId, ...request } });
        return {
          identity: { ...work, status: "archived", version: work.version + 1 },
          operationId: request.operationId,
          replayed: false,
        };
      },
      listBrowserRevisions: async (_workspaceId, identityId) => {
        calls.push({ kind: "history", request: identityId });
        return { identity: work, revisions: [saved] };
      },
      publishBrowserRevision: async (_workspaceId, browserSessionId, request) => {
        calls.push({ kind: "publish", request: { browserSessionId, ...request } });
        return {
          identity: {
            ...work,
            defaultRevisionId: REVISION_ID,
            headGeneration: 2,
            revisionCount: 1,
          },
          revision: saved,
          outcome: "saved_as_default",
          replayed: false,
        };
      },
    });
    const hook = await renderHook(
      () => useBrowserIdentities({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush(10);

    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.revision).toBe(4);
    expect(hook.result.current.identities.map((item) => item.name)).toEqual(["Work", "Personal"]);

    const created = await actRun(() =>
      hook.result.current.create({ name: "Customer", operationId: OPERATION_ID }),
    );
    expect(created.identity.name).toBe("Customer");
    expect(calls[0]).toEqual({
      kind: "create",
      request: { name: "Customer", operationId: OPERATION_ID },
    });

    const history = await actRun(() => hook.result.current.revisions(IDENTITY_ID));
    expect(history.revisions).toEqual([saved]);

    const published = await actRun(() =>
      hook.result.current.publish(BROWSER_SESSION_ID, {
        identityId: IDENTITY_ID,
        expectedHeadGeneration: 1,
        advanceDefault: true,
        operationId: OPERATION_ID,
      }),
    );
    expect(published.outcome).toBe("saved_as_default");
    expect(calls.at(-1)).toEqual({
      kind: "publish",
      request: {
        browserSessionId: BROWSER_SESSION_ID,
        identityId: IDENTITY_ID,
        expectedHeadGeneration: 1,
        advanceDefault: true,
        operationId: OPERATION_ID,
      },
    });
    expect(
      hook.result.current.identities.find((item) => item.id === IDENTITY_ID)?.defaultRevisionId,
    ).toBe(REVISION_ID);

    const archived = await actRun(() =>
      hook.result.current.update(IDENTITY_ID, {
        expectedVersion: work.version,
        status: "archived",
        operationId: OPERATION_ID,
      }),
    );
    expect(archived.identity.status).toBe("archived");
    expect(calls.at(-1)).toEqual({
      kind: "update",
      request: {
        identityId: IDENTITY_ID,
        expectedVersion: work.version,
        status: "archived",
        operationId: OPERATION_ID,
      },
    });
    expect(hook.result.current.identities.some((item) => item.id === IDENTITY_ID)).toBe(false);
    await hook.unmount();
  });
});

function identity(id: string, name: string, updatedAt: string): BrowserIdentity {
  return {
    id,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    name,
    status: "active",
    version: 1,
    defaultRevisionId: null,
    headGeneration: 1,
    revisionCount: 0,
    createdBySubjectId: "user:test",
    createdAt: NOW,
    updatedAt,
  };
}

function revision(browserIdentity: BrowserIdentity): BrowserRevision {
  return {
    id: REVISION_ID,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    identityId: browserIdentity.id,
    parentRevisionId: null,
    ordinal: 1,
    sourceBrowserSessionId: BROWSER_SESSION_ID,
    manifestDigest: "a".repeat(64),
    components: [
      {
        id: crypto.randomUUID(),
        kind: "chromium_profile",
        format: "opengeni.chromium-profile.tgz.aes256gcm.v1",
        artifactDigest: "b".repeat(64),
        sizeBytes: 1_024,
        materialization: {
          portability: "portable",
          reason: null,
          platform: "linux",
          architecture: "x64",
          engine: "chromium",
          engineVersion: "151",
          driverId: "opengeni.cdp.v1",
          driverSchemaVersion: 1,
          profileCrypto: "chromium_basic",
          providerId: null,
          placement: null,
        },
      },
    ],
    createdBySubjectId: "user:test",
    createdAt: NOW,
  };
}
