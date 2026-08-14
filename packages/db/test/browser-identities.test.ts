import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  activateBrowserSession,
  ATTACHED_BROWSER_SESSION_CAPABILITIES,
  bootstrapWorkspace,
  BrowserIdentityConflictError,
  BrowserIdentityNotFoundError,
  BrowserIdentityStateError,
  commitBrowserRevisionPublication,
  completeBrowserSessionEnd,
  createBrowserIdentity,
  createDb,
  createSession,
  dispatchBrowserRevisionPublication,
  dispatchBrowserSessionOperation,
  failBrowserRevisionPublication,
  getBrowserIdentity,
  getBrowserRevisionArtifactAuthority,
  getBrowserSession,
  listBrowserIdentities,
  listBrowserRevisions,
  prepareBrowserRevisionPublication,
  prepareBrowserSessionCreate,
  prepareBrowserSessionEnd,
  updateBrowserIdentity,
  type BrowserStateArtifactCommitInput,
} from "../src";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("browser-identities");
  if (!shared) {
    available = false;
    console.warn("[browser-identities] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `browser-identity-account-${suffix}`,
    accountName: "BrowserIdentity test",
    workspaceExternalSource: "test",
    workspaceExternalId: `browser-identity-workspace-${suffix}`,
    workspaceName: "BrowserIdentity test",
    subjectId: `browser-identity-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    sessionId: session.id,
    sandboxGroupId: session.sandboxGroupId,
  };
}

async function activeBrowser(
  scope: Awaited<ReturnType<typeof fixture>>,
  identity: { identityId: string; baseRevisionId: string } | null = null,
  capabilities?: typeof ATTACHED_BROWSER_SESSION_CAPABILITIES,
) {
  const operationId = crypto.randomUUID();
  const prepared = await prepareBrowserSessionCreate(client.db, {
    ...scope,
    operationId,
    associatedSessionId: scope.sessionId,
    actorSubjectId: scope.subjectId,
    name: `Browser ${operationId.slice(0, 8)}`,
    initialUrl: "https://example.com/",
    placement: {
      kind: "sandbox_group" as const,
      sandboxGroupId: scope.sandboxGroupId,
    },
    driverId: "opengeni.cdp.v1",
    engine: "chromium" as const,
    headless: true,
    identityId: identity?.identityId ?? null,
    baseRevisionId: identity?.baseRevisionId ?? null,
    ...(capabilities ? { capabilities } : {}),
  });
  const controllerGeneration = crypto.randomUUID();
  await dispatchBrowserSessionOperation(client.db, {
    ...scope,
    operationId,
    browserSessionId: prepared.session.id,
    controllerGeneration,
  });
  const activated = await activateBrowserSession(client.db, {
    ...scope,
    operationId,
    browserSessionId: prepared.session.id,
    controller: {
      controllerId: "browserd:test",
      controllerGeneration,
      placementInstanceId: "placement:test",
    },
    engineVersion: "151.0.7922.108",
  });
  return { browserSessionId: activated.session.id, controllerGeneration };
}

function publicationInput(
  scope: Awaited<ReturnType<typeof fixture>>,
  browser: Awaited<ReturnType<typeof activeBrowser>>,
  identityId: string,
  expectedHeadGeneration: number,
  operationId = crypto.randomUUID(),
) {
  return {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    operationId,
    browserSessionId: browser.browserSessionId,
    controllerGeneration: browser.controllerGeneration,
    identityId,
    expectedHeadGeneration,
    advanceDefault: true,
    actorSubjectId: scope.subjectId,
  };
}

function artifact(
  scope: Awaited<ReturnType<typeof fixture>>,
  operationId: string,
): BrowserStateArtifactCommitInput {
  return {
    kind: "chromium_profile",
    format: "application/vnd.opengeni.browser-profile.v1+tar+gzip+aes256gcm",
    artifactDigest: "a".repeat(64),
    contentDigest: "b".repeat(64),
    manifestDigest: "c".repeat(64),
    objectKey: `workspaces/${scope.workspaceId}/browser-state/publications/${operationId}.ogbp`,
    encryptedDataKey: `wrapped-data-key-${operationId}`,
    sizeBytes: 4_096,
    materialization: {
      portability: "portable",
      reason: null,
      platform: "linux",
      architecture: "x64",
      engine: "chromium",
      engineVersion: "151.0.7922.108",
      driverId: "opengeni.cdp.v1",
      driverSchemaVersion: 1,
      profileCrypto: "chromium_basic",
      providerId: null,
      placement: null,
    },
  };
}

async function dispatchAndCommit(
  scope: Awaited<ReturnType<typeof fixture>>,
  input: ReturnType<typeof publicationInput>,
) {
  const prepared = await prepareBrowserRevisionPublication(client.db, input);
  expect(prepared).toMatchObject({
    kind: "pending",
    operationState: "prepared",
  });
  const stateUpload = {
    objectKey: artifact(scope, input.operationId).objectKey,
    cleanupAfter: new Date(Date.now() + 60_000),
  };
  const dispatched = await dispatchBrowserRevisionPublication(client.db, {
    ...input,
    stateUpload,
  });
  expect(dispatched).toMatchObject({ kind: "dispatched", replayed: false });
  expect(
    await dispatchBrowserRevisionPublication(client.db, { ...input, stateUpload }),
  ).toMatchObject({ kind: "dispatched", replayed: true });
  return await commitBrowserRevisionPublication(client.db, {
    ...input,
    manifestDigest: "c".repeat(64),
    artifacts: [artifact(scope, input.operationId)],
  });
}

async function insertRawArtifact(
  scope: Awaited<ReturnType<typeof fixture>>,
  sourceBrowserSessionId: string,
  purpose: "revision_component" | "private_checkpoint",
  kind: BrowserStateArtifactCommitInput["kind"],
) {
  const id = crypto.randomUUID();
  const value = artifact(scope, id);
  await shared!.admin`
    insert into browser_state_artifacts (
      id, account_id, workspace_id, source_browser_session_id, purpose, kind,
      format, artifact_digest, content_digest, manifest_digest, object_key, encrypted_data_key,
      size_bytes, materialization
    ) values (
      ${id}, ${scope.accountId}, ${scope.workspaceId}, ${sourceBrowserSessionId},
      ${purpose}, ${kind}, ${value.format}, ${value.artifactDigest}, ${value.contentDigest},
      ${value.manifestDigest}, ${value.objectKey}, ${value.encryptedDataKey}, ${value.sizeBytes},
      ${shared!.admin.json(value.materialization)}
    )`;
  return id;
}

async function expectDatabaseError(value: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  let error: unknown;
  try {
    await value;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
  expect(error instanceof Error ? error.message : String(error)).toMatch(pattern);
}

describe("immutable BrowserIdentity lineage", () => {
  test("rejects reusable publication from a live-profile BrowserSession", async () => {
    if (!available) return;
    const scope = await fixture();
    const identity = await createBrowserIdentity(client.db, {
      ...scope,
      operationId: crypto.randomUUID(),
      actorSubjectId: scope.subjectId,
      name: "Saved profile",
    });
    const browser = await activeBrowser(scope, null, ATTACHED_BROWSER_SESSION_CAPABILITIES);

    await expect(
      prepareBrowserRevisionPublication(
        client.db,
        publicationInput(scope, browser, identity.identity.id, identity.identity.headGeneration),
      ),
    ).rejects.toBeInstanceOf(BrowserIdentityStateError);
  });

  test("creates identities idempotently with case-insensitive active names and workspace RLS", async () => {
    if (!available) return;
    const owner = await fixture();
    const outsider = await fixture();
    const operationId = crypto.randomUUID();
    const input = {
      ...owner,
      operationId,
      actorSubjectId: owner.subjectId,
      name: "  Research identity  ",
    };
    const [first, second] = await Promise.all([
      createBrowserIdentity(client.db, input),
      createBrowserIdentity(client.db, input),
    ]);
    expect(first.identity.id).toBe(second.identity.id);
    expect(first.identity.name).toBe("Research identity");
    expect(new Set([first.replayed, second.replayed])).toEqual(new Set([false, true]));

    await expect(
      createBrowserIdentity(client.db, {
        ...input,
        name: "Different identity",
      }),
    ).rejects.toBeInstanceOf(BrowserIdentityConflictError);
    await expect(
      createBrowserIdentity(client.db, {
        ...input,
        operationId: crypto.randomUUID(),
        name: "research IDENTITY",
      }),
    ).rejects.toBeInstanceOf(BrowserIdentityConflictError);

    expect((await listBrowserIdentities(client.db, owner)).identities).toHaveLength(1);
    expect((await listBrowserIdentities(client.db, outsider)).identities).toHaveLength(0);
    await expect(
      getBrowserIdentity(client.db, {
        ...outsider,
        identityId: first.identity.id,
      }),
    ).rejects.toBeInstanceOf(BrowserIdentityNotFoundError);
  });

  test("selects defaults and archives or restores identities with exact replay and CAS", async () => {
    if (!available) return;
    const scope = await fixture();
    const created = await createBrowserIdentity(client.db, {
      ...scope,
      operationId: crypto.randomUUID(),
      actorSubjectId: scope.subjectId,
      name: "Reusable work",
    });
    expect(created.identity.version).toBe(1);
    const browser = await activeBrowser(scope);
    const first = await dispatchAndCommit(
      scope,
      publicationInput(scope, browser, created.identity.id, 0),
    );
    const secondInput = {
      ...publicationInput(scope, browser, created.identity.id, 1),
      advanceDefault: false,
    };
    const second = await dispatchAndCommit(scope, secondInput);
    expect(second.outcome).toBe("saved_not_default");
    expect(second.identity.version).toBe(3);

    const selectOperationId = crypto.randomUUID();
    const selected = await updateBrowserIdentity(client.db, {
      ...scope,
      identityId: created.identity.id,
      actorSubjectId: scope.subjectId,
      operationId: selectOperationId,
      expectedVersion: second.identity.version,
      defaultRevisionId: second.revision.id,
    });
    expect(selected).toMatchObject({
      replayed: false,
      identity: {
        version: 4,
        headGeneration: 2,
        defaultRevisionId: second.revision.id,
      },
    });
    expect(
      await updateBrowserIdentity(client.db, {
        ...scope,
        identityId: created.identity.id,
        actorSubjectId: scope.subjectId,
        operationId: selectOperationId,
        expectedVersion: second.identity.version,
        defaultRevisionId: second.revision.id,
      }),
    ).toEqual({ ...selected, replayed: true });

    const archived = await updateBrowserIdentity(client.db, {
      ...scope,
      identityId: created.identity.id,
      actorSubjectId: scope.subjectId,
      operationId: crypto.randomUUID(),
      expectedVersion: selected.identity.version,
      status: "archived",
    });
    expect(archived.identity).toMatchObject({ status: "archived", version: 5 });
    expect((await listBrowserIdentities(client.db, scope)).identities).toEqual([]);
    expect(
      (await listBrowserIdentities(client.db, { ...scope, includeArchived: true })).identities,
    ).toHaveLength(1);
    await expect(
      updateBrowserIdentity(client.db, {
        ...scope,
        identityId: created.identity.id,
        actorSubjectId: scope.subjectId,
        operationId: crypto.randomUUID(),
        expectedVersion: selected.identity.version,
        status: "active",
      }),
    ).rejects.toBeInstanceOf(BrowserIdentityConflictError);
    const restored = await updateBrowserIdentity(client.db, {
      ...scope,
      identityId: created.identity.id,
      actorSubjectId: scope.subjectId,
      operationId: crypto.randomUUID(),
      expectedVersion: archived.identity.version,
      status: "active",
    });
    expect(restored.identity).toMatchObject({ status: "active", version: 6 });
    expect(restored.identity.defaultRevisionId).toBe(second.revision.id);
    expect(first.revision.id).not.toBe(second.revision.id);
  });

  test("freezes the current default revision across idempotent BrowserSession creation", async () => {
    if (!available) return;
    const scope = await fixture();
    const identity = (
      await createBrowserIdentity(client.db, {
        ...scope,
        operationId: crypto.randomUUID(),
        actorSubjectId: scope.subjectId,
        name: "Frozen selection",
      })
    ).identity;
    const firstBrowser = await activeBrowser(scope);
    const first = await dispatchAndCommit(
      scope,
      publicationInput(scope, firstBrowser, identity.id, 0),
    );
    const createOperationId = crypto.randomUUID();
    const createFromDefault = {
      ...scope,
      operationId: createOperationId,
      associatedSessionId: scope.sessionId,
      actorSubjectId: scope.subjectId,
      name: "Frozen BrowserSession",
      initialUrl: null,
      placement: {
        kind: "sandbox_group" as const,
        sandboxGroupId: scope.sandboxGroupId,
      },
      driverId: "opengeni.cdp.v1",
      engine: "chromium" as const,
      headless: true,
      identityId: identity.id,
      baseRevisionId: null,
      resolveDefaultRevision: true,
    };
    const frozenSession = await prepareBrowserSessionCreate(client.db, createFromDefault);
    expect(frozenSession.session.baseRevisionId).toBe(first.revision.id);

    const second = await dispatchAndCommit(
      scope,
      publicationInput(scope, firstBrowser, identity.id, 1),
    );
    expect(second.outcome).toBe("saved_as_default");
    const replayedSession = await prepareBrowserSessionCreate(client.db, createFromDefault);
    expect(replayedSession.operation.replayed).toBe(true);
    expect(replayedSession.session.baseRevisionId).toBe(first.revision.id);
    const nextOperationId = crypto.randomUUID();
    const nextSession = await prepareBrowserSessionCreate(client.db, {
      ...createFromDefault,
      operationId: nextOperationId,
      name: "Next BrowserSession",
    });
    expect(nextSession.session.baseRevisionId).toBe(second.revision.id);
  });

  test("keeps concurrent branches, advances the default once, and replays without secrets", async () => {
    if (!available) return;
    const scope = await fixture();
    const identity = (
      await createBrowserIdentity(client.db, {
        ...scope,
        operationId: crypto.randomUUID(),
        actorSubjectId: scope.subjectId,
        name: "Authenticated work",
      })
    ).identity;
    const firstBrowser = await activeBrowser(scope);
    const firstInput = publicationInput(scope, firstBrowser, identity.id, 0);
    const first = await dispatchAndCommit(scope, firstInput);
    expect(first).toMatchObject({
      outcome: "saved_as_default",
      replayed: false,
    });
    expect(first.revision).toMatchObject({
      parentRevisionId: null,
      ordinal: 1,
    });

    const secondBrowser = await activeBrowser(scope, {
      identityId: identity.id,
      baseRevisionId: first.revision.id,
    });
    const leftInput = publicationInput(scope, firstBrowser, identity.id, 1);
    const rightInput = publicationInput(scope, secondBrowser, identity.id, 1);
    await Promise.all([
      prepareBrowserRevisionPublication(client.db, leftInput),
      prepareBrowserRevisionPublication(client.db, rightInput),
    ]);
    await Promise.all([
      dispatchBrowserRevisionPublication(client.db, {
        ...leftInput,
        stateUpload: {
          objectKey: artifact(scope, leftInput.operationId).objectKey,
          cleanupAfter: new Date(Date.now() + 60_000),
        },
      }),
      dispatchBrowserRevisionPublication(client.db, {
        ...rightInput,
        stateUpload: {
          objectKey: artifact(scope, rightInput.operationId).objectKey,
          cleanupAfter: new Date(Date.now() + 60_000),
        },
      }),
    ]);
    const [left, right] = await Promise.all([
      commitBrowserRevisionPublication(client.db, {
        ...leftInput,
        manifestDigest: "d".repeat(64),
        artifacts: [artifact(scope, leftInput.operationId)],
      }),
      commitBrowserRevisionPublication(client.db, {
        ...rightInput,
        manifestDigest: "e".repeat(64),
        artifacts: [artifact(scope, rightInput.operationId)],
      }),
    ]);

    expect(new Set([left.outcome, right.outcome])).toEqual(
      new Set(["saved_as_default", "saved_not_default"]),
    );
    expect(left.revision.parentRevisionId).toBe(first.revision.id);
    expect(right.revision.parentRevisionId).toBe(first.revision.id);
    expect(left.revision.id).not.toBe(right.revision.id);
    const history = await listBrowserRevisions(client.db, {
      ...scope,
      identityId: identity.id,
    });
    expect(history.identity).toMatchObject({
      headGeneration: 2,
      revisionCount: 3,
    });
    expect(history.revisions.map((revision) => revision.ordinal).sort()).toEqual([1, 2, 3]);
    const winner = left.outcome === "saved_as_default" ? left : right;
    expect(history.identity.defaultRevisionId).toBe(winner.revision.id);

    const replay = await commitBrowserRevisionPublication(client.db, {
      ...leftInput,
      manifestDigest: "d".repeat(64),
      artifacts: [artifact(scope, leftInput.operationId)],
    });
    expect(replay).toMatchObject({ replayed: true, outcome: left.outcome });
    expect(replay.revision.id).toBe(left.revision.id);
    const publicJson = JSON.stringify({ first, left, right, history });
    expect(publicJson).not.toContain("wrapped-data-key");
    expect(publicJson).not.toContain("browser-state/publications");
    expect(publicJson).not.toContain('"contentDigest"');

    const authority = await getBrowserRevisionArtifactAuthority(client.db, {
      ...scope,
      identityId: identity.id,
      revisionId: left.revision.id,
    });
    expect(authority.artifacts[0]).toMatchObject({
      objectKey: artifact(scope, leftInput.operationId).objectKey,
      encryptedDataKey: artifact(scope, leftInput.operationId).encryptedDataKey,
    });
    await expectDatabaseError(
      shared!.admin`
        update browser_state_artifacts
        set encrypted_data_key = 'tampered-encryption-authority'
        where id = ${authority.artifacts[0]!.artifactId}`,
      /immutable authority/u,
    );
    await expectDatabaseError(
      shared!.admin`
        update browser_identities
        set created_by_subject_id = 'tampered-creator'
        where id = ${identity.id}`,
      /immutable authority/u,
    );

    const privateArtifactId = await insertRawArtifact(
      scope,
      firstBrowser.browserSessionId,
      "private_checkpoint",
      "normalized_web_state",
    );
    await expectDatabaseError(
      shared!.admin`
        insert into browser_revision_components (
          id, account_id, workspace_id, identity_id, revision_id, artifact_id,
          source_browser_session_id, artifact_purpose, kind, position
        ) values (
          ${crypto.randomUUID()}, ${scope.accountId}, ${scope.workspaceId}, ${identity.id},
          ${left.revision.id}, ${privateArtifactId}, ${firstBrowser.browserSessionId},
          'revision_component', 'normalized_web_state', 1
        )`,
      /foreign key/u,
    );

    const otherSourceArtifactId = await insertRawArtifact(
      scope,
      secondBrowser.browserSessionId,
      "revision_component",
      "normalized_web_state",
    );
    await expectDatabaseError(
      shared!.admin`
        insert into browser_revision_components (
          id, account_id, workspace_id, identity_id, revision_id, artifact_id,
          source_browser_session_id, artifact_purpose, kind, position
        ) values (
          ${crypto.randomUUID()}, ${scope.accountId}, ${scope.workspaceId}, ${identity.id},
          ${left.revision.id}, ${otherSourceArtifactId}, ${firstBrowser.browserSessionId},
          'revision_component', 'normalized_web_state', 1
        )`,
      /foreign key/u,
    );

    const duplicateKindArtifactId = await insertRawArtifact(
      scope,
      firstBrowser.browserSessionId,
      "revision_component",
      "chromium_profile",
    );
    await expectDatabaseError(
      shared!.admin`
        insert into browser_revision_components (
          id, account_id, workspace_id, identity_id, revision_id, artifact_id,
          source_browser_session_id, artifact_purpose, kind, position
        ) values (
          ${crypto.randomUUID()}, ${scope.accountId}, ${scope.workspaceId}, ${identity.id},
          ${left.revision.id}, ${duplicateKindArtifactId}, ${firstBrowser.browserSessionId},
          'revision_component', 'chromium_profile', 1
        )`,
      /browser_revision_components_revision_kind_uq/u,
    );

    const leftSession = await getBrowserSession(client.db, {
      ...scope,
      browserSessionId: firstBrowser.browserSessionId,
    });
    const rightSession = await getBrowserSession(client.db, {
      ...scope,
      browserSessionId: secondBrowser.browserSessionId,
    });
    expect(leftSession.baseRevisionId).toBe(left.revision.id);
    expect(rightSession.baseRevisionId).toBe(right.revision.id);
  }, 60_000);

  test("fences publication dispatch/failure while leaving the live browser untouched", async () => {
    if (!available) return;
    const scope = await fixture();
    const identity = (
      await createBrowserIdentity(client.db, {
        ...scope,
        operationId: crypto.randomUUID(),
        actorSubjectId: scope.subjectId,
        name: "Failure test",
      })
    ).identity;
    const browser = await activeBrowser(scope);
    const input = publicationInput(scope, browser, identity.id, 0);
    await prepareBrowserRevisionPublication(client.db, input);
    await expect(
      dispatchBrowserRevisionPublication(client.db, {
        ...input,
        controllerGeneration: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(BrowserIdentityConflictError);
    await dispatchBrowserRevisionPublication(client.db, input);
    await expect(
      failBrowserRevisionPublication(client.db, {
        ...input,
        controllerGeneration: crypto.randomUUID(),
        error: {
          code: "driver_failed",
          message: "stale callback",
          retryable: true,
        },
      }),
    ).rejects.toBeInstanceOf(BrowserIdentityConflictError);
    await failBrowserRevisionPublication(client.db, {
      ...input,
      error: {
        code: "driver_failed",
        message: "capture failed",
        retryable: true,
      },
    });
    await failBrowserRevisionPublication(client.db, {
      ...input,
      error: { code: "timeout", message: "different replay", retryable: false },
    });
    expect(
      await getBrowserSession(client.db, {
        ...scope,
        browserSessionId: browser.browserSessionId,
      }),
    ).toMatchObject({
      lifecycle: "active",
      controller: { controllerGeneration: browser.controllerGeneration },
    });
    await expect(prepareBrowserRevisionPublication(client.db, input)).rejects.toBeInstanceOf(
      BrowserIdentityStateError,
    );

    const conflictingIdentity = (
      await createBrowserIdentity(client.db, {
        ...scope,
        operationId: crypto.randomUUID(),
        actorSubjectId: scope.subjectId,
        name: "Conflict identity",
      })
    ).identity;
    await expect(
      prepareBrowserRevisionPublication(client.db, {
        ...input,
        identityId: conflictingIdentity.id,
      }),
    ).rejects.toBeInstanceOf(BrowserIdentityConflictError);
  });

  test("replays a completed publication after the BrowserSession ends", async () => {
    if (!available) return;
    const scope = await fixture();
    const identity = (
      await createBrowserIdentity(client.db, {
        ...scope,
        operationId: crypto.randomUUID(),
        actorSubjectId: scope.subjectId,
        name: "Replay after end",
      })
    ).identity;
    const browser = await activeBrowser(scope);
    const input = publicationInput(scope, browser, identity.id, 0);
    const committed = await dispatchAndCommit(scope, input);
    const endOperationId = crypto.randomUUID();
    await prepareBrowserSessionEnd(client.db, {
      ...scope,
      browserSessionId: browser.browserSessionId,
      operationId: endOperationId,
      actorSubjectId: scope.subjectId,
    });
    await completeBrowserSessionEnd(client.db, {
      ...scope,
      browserSessionId: browser.browserSessionId,
      operationId: endOperationId,
      expectedControllerGeneration: browser.controllerGeneration,
    });
    const replay = await prepareBrowserRevisionPublication(client.db, input);
    expect(replay).toMatchObject({
      kind: "completed",
      response: { replayed: true, revision: { id: committed.revision.id } },
    });
  });
});
