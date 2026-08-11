import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CapabilityPack,
  stableJson,
  type CapabilityPack as CapabilityPackType,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import {
  adoptPackComponentReferences,
  bootstrapWorkspace,
  createDb,
  deferPackInstallationOperation,
  deleteWorkspace,
  finalizePackComponentOwnership,
  finalizePackInstallationOperation,
  finalizePackUninstallOperation,
  getPackInstallation,
  installPortableSkill,
  listInstalledPortableSkills,
  listPackInstallationComponents,
  PackInstallationVersionConflictError,
  PackInstallationVersionRequiredError,
  PackManifestChangedError,
  PackOperationClaimLostError,
  PackOperationIdempotencyError,
  PackOperationInProgressError,
  preparePackInstallationOperation,
  preparePackUninstallOperation,
  previewPackComponentRelease,
  registerWorkspacePack,
  releasePackComponents,
  resolvePackComponentReferences,
  resolvePackInlineSkillReferences,
  uninstallPortableSkill,
  type DbClient,
  type InstallPortableSkillInput,
} from "../src";
import { migrate } from "../src/migrate";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let available = true;
let first: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];
let second: Awaited<ReturnType<typeof bootstrapWorkspace>>["workspaceGrants"][number];

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_PACK_INSTALLATIONS_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_PACK_INSTALLATIONS_TEST_POSTGRES_APP_URL;
  if ((adminUrl && !appUrl) || (!adminUrl && appUrl)) {
    throw new Error(
      "OPENGENI_PACK_INSTALLATIONS_TEST_POSTGRES_ADMIN_URL and OPENGENI_PACK_INSTALLATIONS_TEST_POSTGRES_APP_URL must be set together",
    );
  }
  if (adminUrl && appUrl) {
    await migrate(adminUrl);
    const admin = postgres(adminUrl, { max: 4 });
    shared = {
      admin,
      adminUrl,
      appUrl,
      release: async () => await admin.end().catch(() => undefined),
    };
  } else {
    shared = await acquireSharedTestDatabase("pack-installations");
  }
  if (!shared) {
    available = false;
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("[pack-installations] PostgreSQL is required but unavailable");
    }
    // eslint-disable-next-line no-console
    console.warn("[pack-installations] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  first = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `pack-account-${crypto.randomUUID()}`,
      accountName: "Pack account",
      workspaceExternalSource: "test",
      workspaceExternalId: `pack-workspace-${crypto.randomUUID()}`,
      workspaceName: "Pack workspace",
      subjectId: "user:pack-owner",
    })
  ).workspaceGrants[0]!;
  second = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `pack-foreign-account-${crypto.randomUUID()}`,
      accountName: "Pack foreign account",
      workspaceExternalSource: "test",
      workspaceExternalId: `pack-foreign-workspace-${crypto.randomUUID()}`,
      workspaceName: "Pack foreign workspace",
      subjectId: "user:pack-foreign",
    })
  ).workspaceGrants[0]!;
}, 180_000);

afterAll(async () => {
  if (client && first?.workspaceId) {
    await deleteWorkspace(client.db, first.workspaceId).catch(() => undefined);
  }
  if (client && second?.workspaceId) {
    await deleteWorkspace(client.db, second.workspaceId).catch(() => undefined);
  }
  await client?.close();
  await shared?.release();
}, 60_000);

describe("Pack installation ownership", () => {
  test("composes multiple Packs, preserves shared components, and removes the final owner", async () => {
    if (!available || !client) return;
    const skill = skillInput("shared-release-operator");
    const installedSkill = await installPortableSkill(client.db, skill);
    const component = {
      key: "skills/release-operator",
      kind: "skill" as const,
      capabilityId: skill.capabilityId,
      contentSha256: skill.contentSha256,
      required: true,
    };
    const packA = pack("shared-pack-a", [component]);
    const packB = pack("shared-pack-b", [component]);

    expect(await resolvePackComponentReferences(client.db, first.workspaceId, [component])).toEqual(
      [
        expect.objectContaining({
          status: "ready",
          resolvedId: installedSkill.facetInstallationId,
        }),
      ],
    );
    expect(
      await resolvePackComponentReferences(client.db, second.workspaceId, [component]),
    ).toEqual([expect.objectContaining({ status: "missing", resolvedId: null })]);

    const installedA = await installPack(packA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const installedB = await installPack(packB, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(
      await listPackInstallationComponents(client.db, first.workspaceId, installedA.id),
    ).toEqual([
      expect.objectContaining({
        capabilityId: skill.capabilityId,
        resolvedId: installedSkill.facetInstallationId,
      }),
    ]);
    expect(
      await listPackInstallationComponents(client.db, second.workspaceId, installedA.id),
    ).toEqual([]);

    const replay = await preparePackInstallationOperation(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      pack: packA,
      manifestDigest: packDigest(packA),
      selectedRigId: null,
      metadata: { platformVersion: 2 },
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      requestDigest: installRequestDigest(packA),
    });
    expect(replay.replayResult).toMatchObject({
      status: "installed",
      packId: packA.id,
    });
    await expect(
      preparePackInstallationOperation(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        pack: packA,
        manifestDigest: packDigest(packA),
        selectedRigId: null,
        metadata: { platformVersion: 2 },
        idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        requestDigest: "different-request",
      }),
    ).rejects.toBeInstanceOf(PackOperationIdempotencyError);

    expect(
      await uninstallPortableSkill(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        capabilityId: skill.capabilityId,
        expectedInstallationVersion: 1,
      }),
    ).toMatchObject({ status: "retained_by_other_owners" });
    expect(await listInstalledPortableSkills(client.db, first.workspaceId)).toHaveLength(1);
    expect(await previewPackComponentRelease(client.db, first.workspaceId, installedA.id)).toEqual([
      expect.objectContaining({ retainedByOtherOwners: true }),
    ]);

    const uninstallA = await uninstallPack(
      packA.id,
      installedA.version,
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    );
    expect(uninstallA.retainedComponents).toEqual([skill.capabilityId]);
    expect(await listInstalledPortableSkills(client.db, first.workspaceId)).toHaveLength(1);
    expect(await previewPackComponentRelease(client.db, first.workspaceId, installedB.id)).toEqual([
      expect.objectContaining({ retainedByOtherOwners: false }),
    ]);

    const uninstallB = await uninstallPack(
      packB.id,
      installedB.version,
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    );
    expect(uninstallB.retainedComponents).toEqual([]);
    expect(await listInstalledPortableSkills(client.db, first.workspaceId)).toEqual([]);
    const uninstallReplay = await preparePackUninstallOperation(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      packId: packB.id,
      expectedInstallationVersion: installedB.version,
      idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      requestDigest: uninstallRequestDigest(packB.id, installedB.version),
    });
    expect("installation" in uninstallReplay).toBe(false);
    if (!("installation" in uninstallReplay)) {
      expect(uninstallReplay.replayResult).toMatchObject({
        status: "uninstalled",
      });
    }
  }, 60_000);

  test("preserves a component claimed by a pending Pack when the last active owner uninstalls", async () => {
    if (!available || !client) return;
    const skill = skillInput(`pending-owner-${crypto.randomUUID().slice(0, 8)}`);
    const installedSkill = await installPortableSkill(client.db, skill);
    const component = {
      key: "skills/pending-owner",
      kind: "skill" as const,
      capabilityId: skill.capabilityId,
      contentSha256: skill.contentSha256,
      required: true,
    };
    const activePack = pack(`active-owner-${crypto.randomUUID().slice(0, 8)}`, [component]);
    const pendingPack = pack(`pending-owner-${crypto.randomUUID().slice(0, 8)}`, [component]);
    const activeInstallation = await installPack(
      activePack,
      "66666666-aaaa-4666-8666-666666666666",
    );

    const pending = await preparePackInstallationOperation(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      pack: pendingPack,
      manifestDigest: packDigest(pendingPack),
      selectedRigId: null,
      metadata: { platformVersion: 2 },
      idempotencyKey: "77777777-aaaa-4777-8777-777777777777",
      requestDigest: installRequestDigest(pendingPack),
    });
    const adopted = await adoptPackComponentReferences(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      packInstallationId: pending.installation.id,
      references: pendingPack.components,
    });
    await finalizePackComponentOwnership(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      packInstallationId: pending.installation.id,
      retainedComponentKeys: adopted.components.map((entry) => entry.key),
      retainedFacetInstallationIds: adopted.retainedFacetInstallationIds,
      retainedBindingIds: adopted.retainedBindingIds,
    });

    expect(
      await uninstallPortableSkill(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        capabilityId: skill.capabilityId,
        expectedInstallationVersion: installedSkill.installationVersion,
      }),
    ).toMatchObject({ status: "retained_by_other_owners" });
    expect(
      await uninstallPack(
        activePack.id,
        activeInstallation.version,
        "88888888-aaaa-4888-8888-888888888888",
      ),
    ).toEqual({ retainedComponents: [] });
    expect(await listInstalledPortableSkills(client.db, first.workspaceId)).toEqual([]);
    expect(
      await listPackInstallationComponents(client.db, first.workspaceId, pending.installation.id),
    ).toEqual([
      expect.objectContaining({
        capabilityId: skill.capabilityId,
        resolvedId: installedSkill.facetInstallationId,
      }),
    ]);

    const activatedPending = await finalizePackInstallationOperation(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      operationId: pending.operationId,
      operationVersion: pending.operationVersion,
      packInstallationId: pending.installation.id,
      packId: pendingPack.id,
      result: { status: "installed", packId: pendingPack.id },
    });
    expect(await listInstalledPortableSkills(client.db, first.workspaceId)).toEqual([
      expect.objectContaining({
        capabilityId: skill.capabilityId,
        contentSha256: skill.contentSha256,
      }),
    ]);
    await uninstallPack(
      pendingPack.id,
      activatedPending.version,
      "99999999-aaaa-4999-8999-999999999999",
    );
    expect(await listInstalledPortableSkills(client.db, first.workspaceId)).toEqual([]);
  }, 60_000);

  test("enforces OCC, running exclusion, same-key resume, and fresh-key recovery", async () => {
    if (!available || !client || !shared) return;
    const manifest = pack("operation-fences", []);
    const installed = await installPack(manifest, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    await expect(
      preparePackInstallationOperation(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        pack: manifest,
        manifestDigest: packDigest(manifest),
        selectedRigId: null,
        metadata: { platformVersion: 2 },
        idempotencyKey: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        requestDigest: "missing-version",
      }),
    ).rejects.toBeInstanceOf(PackInstallationVersionRequiredError);
    await expect(
      preparePackInstallationOperation(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        pack: manifest,
        manifestDigest: packDigest(manifest),
        selectedRigId: null,
        metadata: { platformVersion: 2 },
        idempotencyKey: "11111111-aaaa-4111-8111-111111111111",
        requestDigest: "wrong-version",
        expectedInstallationVersion: installed.version + 1,
      }),
    ).rejects.toBeInstanceOf(PackInstallationVersionConflictError);

    const requestDigest = sha256("resumable-update");
    const prepared = await preparePackInstallationOperation(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      pack: manifest,
      manifestDigest: packDigest(manifest),
      selectedRigId: null,
      metadata: { platformVersion: 2 },
      idempotencyKey: "22222222-aaaa-4222-8222-222222222222",
      requestDigest,
      expectedInstallationVersion: installed.version,
    });
    await expect(
      preparePackInstallationOperation(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        pack: manifest,
        manifestDigest: packDigest(manifest),
        selectedRigId: null,
        metadata: { platformVersion: 2 },
        idempotencyKey: "22222222-aaaa-4222-8222-222222222222",
        requestDigest,
        expectedInstallationVersion: installed.version,
      }),
    ).rejects.toBeInstanceOf(PackOperationInProgressError);
    await shared.admin`
      update capability_operations
      set updated_at = now() - interval '16 minutes'
      where id = ${prepared.operationId}`;
    const resumed = await preparePackInstallationOperation(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      pack: manifest,
      manifestDigest: packDigest(manifest),
      selectedRigId: null,
      metadata: { platformVersion: 2 },
      idempotencyKey: "22222222-aaaa-4222-8222-222222222222",
      requestDigest,
      expectedInstallationVersion: installed.version,
    });
    expect(resumed.operationId).toBe(prepared.operationId);
    expect(resumed.operationVersion).toBe(prepared.operationVersion + 1);
    await expect(
      deferPackInstallationOperation(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        operationId: prepared.operationId,
        operationVersion: prepared.operationVersion,
        packInstallationId: prepared.installation.id,
        phase: "stale_handler_failed",
        errorCode: "stale_claim",
      }),
    ).rejects.toBeInstanceOf(PackOperationClaimLostError);
    await expect(
      preparePackInstallationOperation(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        pack: manifest,
        manifestDigest: packDigest(manifest),
        selectedRigId: null,
        metadata: { platformVersion: 2 },
        idempotencyKey: "33333333-aaaa-4333-8333-333333333333",
        requestDigest: "different-operation",
        expectedInstallationVersion: resumed.installation.version,
      }),
    ).rejects.toBeInstanceOf(PackOperationInProgressError);
    await shared.admin`
      update capability_operations
      set updated_at = now() - interval '16 minutes'
      where id = ${resumed.operationId}`;
    const replacement = await preparePackInstallationOperation(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      pack: manifest,
      manifestDigest: packDigest(manifest),
      selectedRigId: null,
      metadata: { platformVersion: 2 },
      idempotencyKey: "33333333-aaaa-4333-8333-333333333333",
      requestDigest: sha256("replacement-operation"),
      expectedInstallationVersion: resumed.installation.version,
    });
    expect(replacement.operationId).not.toBe(prepared.operationId);
    await expect(
      finalizePackInstallationOperation(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        operationId: resumed.operationId,
        operationVersion: resumed.operationVersion,
        packInstallationId: resumed.installation.id,
        packId: manifest.id,
        result: { status: "installed", packId: manifest.id },
      }),
    ).rejects.toBeInstanceOf(PackOperationClaimLostError);
    await deferPackInstallationOperation(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      operationId: replacement.operationId,
      operationVersion: replacement.operationVersion,
      packInstallationId: replacement.installation.id,
      phase: `component_failed:${"x".repeat(200)}`,
      errorCode: "test_failure",
    });
    await expect(
      preparePackInstallationOperation(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        pack: manifest,
        manifestDigest: packDigest(manifest),
        selectedRigId: null,
        metadata: { platformVersion: 2 },
        idempotencyKey: "55555555-bbbb-4555-8555-555555555555",
        requestDigest: sha256("stale-preview-replacement"),
        expectedInstallationVersion: installed.version,
      }),
    ).rejects.toBeInstanceOf(PackInstallationVersionConflictError);
    const resumedReplacement = await preparePackInstallationOperation(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      pack: manifest,
      manifestDigest: packDigest(manifest),
      selectedRigId: null,
      metadata: { platformVersion: 2 },
      idempotencyKey: "33333333-aaaa-4333-8333-333333333333",
      requestDigest: sha256("replacement-operation"),
      expectedInstallationVersion: replacement.installation.version,
    });
    await deferPackInstallationOperation(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      operationId: resumedReplacement.operationId,
      operationVersion: resumedReplacement.operationVersion,
      packInstallationId: resumedReplacement.installation.id,
      phase: "component_failed:browser_lost_retry_key",
      errorCode: "test_failure",
    });
    const browserRecovery = await preparePackInstallationOperation(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      pack: manifest,
      manifestDigest: packDigest(manifest),
      selectedRigId: null,
      metadata: { platformVersion: 2 },
      idempotencyKey: "44444444-bbbb-4444-8444-444444444444",
      requestDigest: sha256("browser-recovery-operation"),
      expectedInstallationVersion: resumedReplacement.installation.version,
    });
    expect(browserRecovery.operationId).not.toBe(replacement.operationId);
    await expect(
      preparePackInstallationOperation(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        pack: manifest,
        manifestDigest: packDigest(manifest),
        selectedRigId: null,
        metadata: { platformVersion: 2 },
        idempotencyKey: "22222222-aaaa-4222-8222-222222222222",
        requestDigest,
        expectedInstallationVersion: installed.version,
      }),
    ).rejects.toBeInstanceOf(PackOperationIdempotencyError);
    await finalizePackInstallationOperation(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      operationId: browserRecovery.operationId,
      operationVersion: browserRecovery.operationVersion,
      packInstallationId: browserRecovery.installation.id,
      packId: manifest.id,
      result: { status: "installed", packId: manifest.id },
    });
  }, 60_000);

  test("shares exact inline Skills and blocks same-name content conflicts", async () => {
    if (!available || !client) return;
    const skill = skillInput(`inline-conflict-${crypto.randomUUID().slice(0, 8)}`);
    const installed = await installPortableSkill(client.db, skill);
    const requirement = {
      key: `inline-skill/${skill.name}`,
      capabilityId: `skill:pack-inline/${skill.name}@${skill.contentSha256}`,
      name: skill.name.toUpperCase(),
      contentSha256: skill.contentSha256,
    };

    expect(
      await resolvePackInlineSkillReferences(client.db, first.workspaceId, [requirement]),
    ).toEqual([
      expect.objectContaining({
        status: "ready",
        actualDigest: skill.contentSha256,
        resolvedId: installed.facetInstallationId,
      }),
    ]);

    const conflictingDigest = sha256("different inline Skill content");
    expect(
      await resolvePackInlineSkillReferences(client.db, first.workspaceId, [
        { ...requirement, contentSha256: conflictingDigest },
      ]),
    ).toEqual([
      expect.objectContaining({
        status: "mismatch",
        expectedDigest: conflictingDigest,
        actualDigest: skill.contentSha256,
        resolvedId: null,
      }),
    ]);

    expect(
      await resolvePackInlineSkillReferences(client.db, second.workspaceId, [
        { ...requirement, contentSha256: conflictingDigest },
      ]),
    ).toEqual([
      expect.objectContaining({
        status: "ready",
        expectedDigest: conflictingDigest,
        actualDigest: conflictingDigest,
        resolvedId: requirement.capabilityId,
      }),
    ]);
  }, 60_000);

  test("fences a registered Pack manifest change at operation admission", async () => {
    if (!available || !client) return;
    const packId = `registered-fence-${crypto.randomUUID().slice(0, 8)}`;
    const original = pack(packId, []);
    const replacement = CapabilityPack.parse({ ...original, version: "2.0.0" });
    await registerWorkspacePack(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      pack: original,
    });
    const originalDigest = packDigest(original);
    await registerWorkspacePack(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      pack: replacement,
    });

    await expect(
      preparePackInstallationOperation(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        pack: original,
        manifestDigest: originalDigest,
        registeredManifestDigest: originalDigest,
        selectedRigId: null,
        metadata: { platformVersion: 2 },
        idempotencyKey: "12121212-aaaa-4212-8212-121212121212",
        requestDigest: sha256("stale-registered-manifest"),
      }),
    ).rejects.toBeInstanceOf(PackManifestChangedError);

    const replacementDigest = packDigest(replacement);
    const prepared = await preparePackInstallationOperation(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      subjectId: first.subjectId,
      pack: replacement,
      manifestDigest: replacementDigest,
      registeredManifestDigest: replacementDigest,
      selectedRigId: null,
      metadata: { platformVersion: 2 },
      idempotencyKey: "13131313-aaaa-4313-8313-131313131313",
      requestDigest: sha256("current-registered-manifest"),
    });
    await finalizePackInstallationOperation(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      operationId: prepared.operationId,
      operationVersion: prepared.operationVersion,
      packInstallationId: prepared.installation.id,
      packId,
      result: { status: "installed", packId },
    });
  }, 60_000);

  test("rejects cross-tenant Rig and component-ledger references at the database boundary", async () => {
    if (!available || !client || !shared) return;
    const [foreignRig] = await shared.admin<{ id: string }[]>`
      insert into rigs (account_id, workspace_id, name)
      values (${second.accountId}, ${second.workspaceId}, 'Foreign Rig')
      returning id`;
    const manifest = pack("foreign-rig-rejected", []);
    let rigError: unknown;
    try {
      await preparePackInstallationOperation(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        subjectId: first.subjectId,
        pack: manifest,
        manifestDigest: packDigest(manifest),
        selectedRigId: foreignRig!.id,
        metadata: { platformVersion: 2 },
        idempotencyKey: "44444444-aaaa-4444-8444-444444444444",
        requestDigest: sha256("foreign-rig"),
      });
    } catch (error) {
      rigError = error;
    }
    expect(errorChainMessage(rigError)).toContain("belongs to another tenant");

    const foreignPack = pack("foreign-ledger-target", []);
    const foreignInstallation = await installPackForGrant(
      second,
      foreignPack,
      "55555555-aaaa-4555-8555-555555555555",
    );
    let ledgerError: unknown;
    try {
      await shared.admin`
        insert into pack_installation_components
          (account_id, workspace_id, pack_installation_id, component_key, kind,
           capability_id, resolved_id, digest, metadata)
        values
          (${first.accountId}, ${first.workspaceId}, ${foreignInstallation.id}, 'skills/cross-tenant',
           'skill', 'skill:cross-tenant', 'resolved-cross-tenant', ${"a".repeat(64)}, '{}'::jsonb)`;
    } catch (error) {
      ledgerError = error;
    }
    expect(errorChainMessage(ledgerError)).toContain("does not match its installation tenant");

    const targetSkill = await installPortableSkill(
      client.db,
      skillInput(`owner-target-${crypto.randomUUID().slice(0, 8)}`),
    );
    const foreignSkillInput = skillInput(`owner-foreign-${crypto.randomUUID().slice(0, 8)}`);
    const foreignSkill = await installPortableSkill(client.db, {
      ...foreignSkillInput,
      accountId: second.accountId,
      workspaceId: second.workspaceId,
      subjectId: second.subjectId,
    });
    const [foreignPlugin] = await shared.admin<{ pluginInstallationId: string }[]>`
      select plugin_installation_id as "pluginInstallationId"
      from capability_facet_installations
      where id = ${foreignSkill.facetInstallationId}`;
    expect(foreignPlugin?.pluginInstallationId).toBeTruthy();

    let pluginOwnerError: unknown;
    try {
      await shared.admin`
        insert into capability_component_owners
          (account_id, workspace_id, facet_installation_id, owner_kind, owner_id, removable)
        values
          (${first.accountId}, ${first.workspaceId}, ${targetSkill.facetInstallationId},
           'plugin', ${foreignPlugin!.pluginInstallationId}, true)`;
    } catch (error) {
      pluginOwnerError = error;
    }
    expect(errorChainMessage(pluginOwnerError)).toContain(
      "plugin component owner belongs to another tenant",
    );

    let packOwnerError: unknown;
    try {
      await shared.admin`
        insert into capability_component_owners
          (account_id, workspace_id, facet_installation_id, owner_kind, owner_id, removable)
        values
          (${first.accountId}, ${first.workspaceId}, ${targetSkill.facetInstallationId},
           'pack', ${foreignInstallation.id}, true)`;
    } catch (error) {
      packOwnerError = error;
    }
    expect(errorChainMessage(packOwnerError)).toContain(
      "Pack component owner belongs to another tenant",
    );

    await shared.admin`
      insert into capability_component_owners
        (account_id, workspace_id, facet_installation_id, owner_kind, owner_id, removable)
      values
        (${first.accountId}, ${first.workspaceId}, ${targetSkill.facetInstallationId},
         'pack', 'pack:legacy-rolling-owner', true)`;
    expect(await getPackInstallation(client.db, first.workspaceId, foreignPack.id)).toBeNull();
  }, 60_000);
});

async function installPack(
  manifest: CapabilityPackType,
  idempotencyKey: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getPackInstallation>>>> {
  return await installPackForGrant(first, manifest, idempotencyKey);
}

async function installPackForGrant(
  grant: typeof first,
  manifest: CapabilityPackType,
  idempotencyKey: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getPackInstallation>>>> {
  if (!client) throw new Error("database client unavailable");
  const prepared = await preparePackInstallationOperation(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    pack: manifest,
    manifestDigest: packDigest(manifest),
    selectedRigId: null,
    metadata: { platformVersion: 2 },
    idempotencyKey,
    requestDigest: installRequestDigest(manifest),
  });
  const adopted = await adoptPackComponentReferences(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    packInstallationId: prepared.installation.id,
    references: manifest.components,
  });
  await finalizePackComponentOwnership(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    packInstallationId: prepared.installation.id,
    retainedComponentKeys: adopted.components.map((component) => component.key),
    retainedFacetInstallationIds: adopted.retainedFacetInstallationIds,
    retainedBindingIds: adopted.retainedBindingIds,
  });
  return await finalizePackInstallationOperation(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    operationId: prepared.operationId,
    operationVersion: prepared.operationVersion,
    packInstallationId: prepared.installation.id,
    packId: manifest.id,
    result: { status: "installed", packId: manifest.id },
  });
}

async function uninstallPack(
  packId: string,
  expectedInstallationVersion: number,
  idempotencyKey: string,
): Promise<{ retainedComponents: string[] }> {
  if (!client) throw new Error("database client unavailable");
  const requestDigest = uninstallRequestDigest(packId, expectedInstallationVersion);
  const prepared = await preparePackUninstallOperation(client.db, {
    accountId: first.accountId,
    workspaceId: first.workspaceId,
    subjectId: first.subjectId,
    packId,
    expectedInstallationVersion,
    idempotencyKey,
    requestDigest,
  });
  if (!("installation" in prepared)) {
    return {
      retainedComponents: Array.isArray(prepared.replayResult.retainedComponents)
        ? prepared.replayResult.retainedComponents.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    };
  }
  const released = await releasePackComponents(client.db, {
    accountId: first.accountId,
    workspaceId: first.workspaceId,
    packInstallationId: prepared.installation.id,
  });
  await finalizePackUninstallOperation(client.db, {
    accountId: first.accountId,
    workspaceId: first.workspaceId,
    operationId: prepared.operationId,
    operationVersion: prepared.operationVersion,
    packInstallationId: prepared.installation.id,
    packId,
    result: {
      status: "uninstalled",
      retainedComponents: released.retainedComponents,
    },
  });
  return released;
}

function pack(id: string, components: CapabilityPackType["components"]): CapabilityPackType {
  return CapabilityPack.parse({
    id,
    name: id,
    description: `Test Pack ${id}`,
    role: "test",
    category: "test",
    version: "1.0.0",
    components,
  });
}

function skillInput(slug: string): InstallPortableSkillInput {
  const content = `---\nname: ${slug}\ndescription: Verify ${slug} safely.\n---\n# ${slug}\n`;
  const contentSha256 = sha256(content);
  return {
    accountId: first.accountId,
    workspaceId: first.workspaceId,
    subjectId: first.subjectId,
    capabilityId: `skill:${slug}-${sha256(slug).slice(0, 12)}`,
    pluginKey: `skill/acme/skills/${slug}`,
    source: "github",
    sourceUrl: `https://github.com/acme/skills/tree/${"a".repeat(40)}/${slug}`,
    repositoryUrl: "https://github.com/acme/skills",
    sourceCommit: "a".repeat(40),
    sourcePath: slug,
    name: slug,
    description: `Verify ${slug} safely.`,
    contentSha256,
    totalBytes: Buffer.byteLength(content),
    files: [
      {
        path: "SKILL.md",
        content,
        byteSize: Buffer.byteLength(content),
        contentSha256,
      },
    ],
  };
}

function packDigest(manifest: CapabilityPackType): string {
  return sha256(stableJson(manifest));
}

function installRequestDigest(manifest: CapabilityPackType): string {
  return sha256(stableJson({ packId: manifest.id, manifestDigest: packDigest(manifest) }));
}

function uninstallRequestDigest(packId: string, expectedInstallationVersion: number): string {
  return sha256(stableJson({ packId, expectedInstallationVersion }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorChainMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) messages.push(current.message);
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return messages.join("\n");
}
