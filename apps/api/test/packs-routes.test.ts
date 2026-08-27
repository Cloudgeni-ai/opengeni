import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createRig,
  deleteWorkspace,
  listInstalledPortableSkills,
  type DbClient,
} from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import postgres from "postgres";

import { registerPackRoutes } from "../src/routes/packs";

const delegationSecret = "pack-route-secret";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let available = true;
let accountId = "";
let workspaceId = "";
let subjectId = "";

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_API_PACKS_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_API_PACKS_TEST_POSTGRES_APP_URL;
  if ((adminUrl && !appUrl) || (!adminUrl && appUrl)) {
    throw new Error(
      "OPENGENI_API_PACKS_TEST_POSTGRES_ADMIN_URL and OPENGENI_API_PACKS_TEST_POSTGRES_APP_URL must be set together",
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
    shared = await acquireSharedTestDatabase("api-packs");
  }
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[api-packs] docker unavailable, skipping");
    return;
  }

  client = createDb(shared.appUrl);
  subjectId = `user:pack-route-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `pack-route-account-${crypto.randomUUID()}`,
    accountName: "Pack route account",
    workspaceExternalSource: "test",
    workspaceExternalId: `pack-route-workspace-${crypto.randomUUID()}`,
    workspaceName: "Pack route workspace",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  accountId = grant.accountId;
  workspaceId = grant.workspaceId;

  app = new Hono();
  registerPackRoutes(app, {
    db: client.db,
    settings: testSettings({ productAccessMode: "managed", delegationSecret }),
    objectStorage: null,
    workflowClient: {},
  } as unknown as ApiRouteDeps);
}, 180_000);

afterAll(async () => {
  if (client && workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 60_000);

async function authorization(): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(delegationSecret, {
    accountId,
    workspaceId,
    subjectId,
    permissions: ["workspace:read", "workspace:admin"],
    principalKind: "human_session",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}`;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return await app!.request(`http://x/v1/workspaces/${workspaceId}${path}`, {
    ...init,
    headers: {
      authorization: await authorization(),
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

describe("Pack routes", () => {
  test("reviews, installs, shares, and safely uninstalls inline-Skill Packs", async () => {
    if (!available || !client) return;
    const suffix = crypto.randomUUID().slice(0, 8);
    const skillName = `pack-route-skill-${suffix}`;
    const packA = `pack-route-a-${suffix}`;
    const packB = `pack-route-b-${suffix}`;
    const packConflict = `pack-route-conflict-${suffix}`;
    const manifest = (id: string, runbook = "Verify, apply, and observe.") => ({
      id,
      name: id,
      description: `Composable Pack ${id}`,
      role: "infrastructure",
      category: "deployment",
      version: "1.0.0",
      skills: [
        {
          name: skillName,
          description: "Operate infrastructure safely.",
          files: [
            {
              path: "SKILL.md",
              content: `---\nname: ${skillName}\ndescription: Operate infrastructure safely.\n---\n# Safe operations\n`,
            },
            { path: "references/runbook.md", content: runbook },
          ],
        },
      ],
    });

    for (const pack of [manifest(packA), manifest(packB)]) {
      const registered = await request("/packs", {
        method: "POST",
        body: JSON.stringify(pack),
      });
      const body = await registered.text();
      expect(registered.status, body).toBe(201);
      expect(JSON.parse(body)).toMatchObject({
        pack: { id: pack.id, components: [] },
      });
    }

    const legacyEnable = await request(`/packs/${packA}/enable`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(legacyEnable.status).toBe(409);
    expect(await legacyEnable.text()).toContain("Pack installation flow");

    const previewWithoutRig = await request(`/packs/${packA}/installation-preview`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(previewWithoutRig.status).toBe(200);
    expect(await previewWithoutRig.json()).toMatchObject({
      ready: true,
      rig: { required: false, status: "not_required" },
      legacyInlineSkillCount: 1,
      legacySandboxImage: null,
    });

    const [rigA, rigB] = await Promise.all([
      createRig(client.db, {
        accountId,
        workspaceId,
        name: `Pack route A ${suffix}`,
        createdBy: subjectId,
        initialVersion: { setupScript: "true" },
      }),
      createRig(client.db, {
        accountId,
        workspaceId,
        name: `Pack route B ${suffix}`,
        createdBy: subjectId,
        initialVersion: { setupScript: "true" },
      }),
    ]);

    const preview = async (packId: string, rigId: string) => {
      const response = await request(`/packs/${packId}/installation-preview`, {
        method: "POST",
        body: JSON.stringify({ rigId }),
      });
      const body = await response.text();
      expect(response.status, body).toBe(200);
      return JSON.parse(body) as {
        manifestDigest: string;
        installationVersion: number | null;
        ready: boolean;
        components: Array<{
          key: string;
          status: string;
          resolvedId: string | null;
        }>;
      };
    };
    const install = async (
      packId: string,
      rigId: string,
      plan: Awaited<ReturnType<typeof preview>>,
      idempotencyKey = crypto.randomUUID(),
    ) => {
      const requestBody = {
        expectedManifestDigest: plan.manifestDigest,
        rigId,
        idempotencyKey,
      };
      const response = await request(`/packs/${packId}/install`, {
        method: "POST",
        body: JSON.stringify(requestBody),
      });
      const body = await response.text();
      expect(response.status, body).toBe(201);
      return {
        installation: JSON.parse(body) as {
          id: string;
          status: string;
          selectedRigId: string;
          version: number;
        },
        requestBody,
      };
    };

    const planA = await preview(packA, rigA.id);
    expect(planA).toMatchObject({ ready: true, installationVersion: null });
    expect(planA.components).toEqual([
      expect.objectContaining({
        key: `inline-skill/${skillName}`,
        status: "ready",
      }),
    ]);
    const staleManifest = await request(`/packs/${packA}/install`, {
      method: "POST",
      body: JSON.stringify({
        expectedManifestDigest: "f".repeat(64),
        rigId: rigA.id,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(staleManifest.status).toBe(409);
    expect(await staleManifest.text()).toContain("manifest changed after preview");

    const installedA = await install(packA, rigA.id, planA, crypto.randomUUID());
    expect(installedA.installation).toMatchObject({
      status: "active",
      selectedRigId: rigA.id,
    });
    const replayA = await request(`/packs/${packA}/install`, {
      method: "POST",
      body: JSON.stringify(installedA.requestBody),
    });
    expect(replayA.status).toBe(200);
    expect(await replayA.json()).toMatchObject({
      id: installedA.installation.id,
      status: "active",
      version: installedA.installation.version,
    });
    const conflictingReplayA = await request(`/packs/${packA}/install`, {
      method: "POST",
      body: JSON.stringify({ ...installedA.requestBody, metadata: { attempt: 2 } }),
    });
    expect(conflictingReplayA.status).toBe(409);
    expect(await conflictingReplayA.text()).toContain("idempotency key was already used");

    const refreshedPlanA = await preview(packA, rigA.id);
    const staleVersion = await request(`/packs/${packA}/install`, {
      method: "POST",
      body: JSON.stringify({
        expectedManifestDigest: refreshedPlanA.manifestDigest,
        expectedInstallationVersion: installedA.installation.version + 1,
        rigId: rigA.id,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    expect(staleVersion.status).toBe(409);
    expect(await staleVersion.text()).toContain("installation changed after preview");

    const registeredConflict = await request("/packs", {
      method: "POST",
      body: JSON.stringify(manifest(packConflict, "Different content under the same Skill name.")),
    });
    expect(registeredConflict.status).toBe(201);
    const conflictPlan = await preview(packConflict, rigA.id);
    expect(conflictPlan.ready).toBe(false);
    expect(conflictPlan.components).toEqual([
      expect.objectContaining({
        key: `inline-skill/${skillName}`,
        status: "mismatch",
        resolvedId: null,
      }),
    ]);

    const planB = await preview(packB, rigB.id);
    expect(planB).toMatchObject({ ready: true, installationVersion: null });
    expect(planB.components[0]?.resolvedId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect((await install(packB, rigB.id, planB)).installation).toMatchObject({
      status: "active",
      selectedRigId: rigB.id,
    });
    expect(
      (await listInstalledPortableSkills(client.db, workspaceId)).filter(
        (skill) => skill.name === skillName,
      ),
    ).toHaveLength(1);

    const unregisterActive = await request(`/packs/${packA}`, { method: "DELETE" });
    expect(unregisterActive.status).toBe(409);

    const uninstallPreviewAResponse = await request(`/packs/${packA}/uninstall-preview`);
    expect(uninstallPreviewAResponse.status).toBe(200);
    const uninstallPreviewA = (await uninstallPreviewAResponse.json()) as {
      installationVersion: number;
      components: Array<{ retainedByOtherOwners: boolean }>;
    };
    expect(uninstallPreviewA.components).toEqual([
      expect.objectContaining({ retainedByOtherOwners: true }),
    ]);
    const uninstallA = await request(`/packs/${packA}/installation`, {
      method: "DELETE",
      body: JSON.stringify({
        expectedInstallationVersion: uninstallPreviewA.installationVersion,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    const uninstallABody = await uninstallA.text();
    expect(uninstallA.status, uninstallABody).toBe(200);
    expect(JSON.parse(uninstallABody)).toMatchObject({ status: "uninstalled" });
    expect(
      (await listInstalledPortableSkills(client.db, workspaceId)).filter(
        (skill) => skill.name === skillName,
      ),
    ).toHaveLength(1);

    const uninstallPreviewBResponse = await request(`/packs/${packB}/uninstall-preview`);
    expect(uninstallPreviewBResponse.status).toBe(200);
    const uninstallPreviewB = (await uninstallPreviewBResponse.json()) as {
      installationVersion: number;
      components: Array<{ retainedByOtherOwners: boolean }>;
    };
    expect(uninstallPreviewB.components).toEqual([
      expect.objectContaining({ retainedByOtherOwners: false }),
    ]);
    const uninstallB = await request(`/packs/${packB}/installation`, {
      method: "DELETE",
      body: JSON.stringify({
        expectedInstallationVersion: uninstallPreviewB.installationVersion,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    const uninstallBBody = await uninstallB.text();
    expect(uninstallB.status, uninstallBBody).toBe(200);
    expect(JSON.parse(uninstallBBody)).toMatchObject({
      status: "uninstalled",
      retainedComponents: [],
    });
    expect(
      (await listInstalledPortableSkills(client.db, workspaceId)).filter(
        (skill) => skill.name === skillName,
      ),
    ).toHaveLength(0);
  }, 60_000);

  test("blocks v2 Pack sandboxImage requirements while Rig images are disabled", async () => {
    if (!available || !client) return;
    const suffix = crypto.randomUUID().slice(0, 8);
    const packId = `pack-route-image-blocked-${suffix}`;
    const sandboxImage =
      "example.com/retired-pack-base@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const registered = await request("/packs", {
      method: "POST",
      body: JSON.stringify({
        id: packId,
        name: packId,
        description: "Requires a retired explicit image",
        role: "infrastructure",
        category: "deployment",
        version: "1.0.0",
        sandboxImage,
        skills: [],
      }),
    });
    expect(registered.status).toBe(201);

    const rig = await createRig(client.db, {
      accountId,
      workspaceId,
      name: `Platform Rig ${suffix}`,
      createdBy: subjectId,
      initialVersion: { setupScript: "true" },
    });
    const preview = await request(`/packs/${packId}/installation-preview`, {
      method: "POST",
      body: JSON.stringify({ rigId: rig.id }),
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      ready: false,
      rig: { required: true, status: "mismatch", image: null },
      blockers: [expect.stringContaining("deployment-managed platform sandbox")],
    });
  });
});
