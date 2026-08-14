import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken } from "@opengeni/contracts";
import type { ApiRouteDeps, GitHubSkillSourceClient } from "@opengeni/core";
import { bootstrapWorkspace, createDb, deleteWorkspace, type DbClient } from "@opengeni/db";
import { migrate } from "@opengeni/db/migrate";
import { listSkillLibraryEntries } from "@opengeni/runtime";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import postgres from "postgres";

import { registerSkillRoutes } from "../src/routes/skills";

const delegationSecret = "portable-skill-route-secret";
const skillMarkdown = `---
name: release-operator
description: Prepare, verify, and publish a safe release.
---
# Release operator
`;

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
let available = true;
let accountId = "";
let workspaceId = "";
let subjectId = "";
let sourceCommit = "a".repeat(40);

const github: GitHubSkillSourceClient = {
  resolveCommit: async () => sourceCommit,
  listTree: async () => [
    {
      path: "release-operator/SKILL.md",
      type: "blob",
      mode: "100644",
      sha: "b".repeat(40),
      size: Buffer.byteLength(skillMarkdown),
    },
  ],
  readBlob: async () => new TextEncoder().encode(skillMarkdown),
};

beforeAll(async () => {
  const adminUrl = process.env.OPENGENI_API_PORTABLE_SKILLS_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_API_PORTABLE_SKILLS_TEST_POSTGRES_APP_URL;
  if ((adminUrl && !appUrl) || (!adminUrl && appUrl)) {
    throw new Error(
      "OPENGENI_API_PORTABLE_SKILLS_TEST_POSTGRES_ADMIN_URL and OPENGENI_API_PORTABLE_SKILLS_TEST_POSTGRES_APP_URL must be set together",
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
    shared = await acquireSharedTestDatabase("api-portable-skills");
  }
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[api-portable-skills] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  subjectId = `user:portable-skill-route-${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `portable-skill-route-account-${crypto.randomUUID()}`,
    accountName: "Portable Skill route account",
    workspaceExternalSource: "test",
    workspaceExternalId: `portable-skill-route-workspace-${crypto.randomUUID()}`,
    workspaceName: "Portable Skill route workspace",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  accountId = grant.accountId;
  workspaceId = grant.workspaceId;
  app = new Hono();
  registerSkillRoutes(
    app,
    {
      db: client.db,
      settings: testSettings({
        productAccessMode: "managed",
        delegationSecret,
      }),
    } as ApiRouteDeps,
    { github },
  );
}, 180_000);

afterAll(async () => {
  if (client && workspaceId) await deleteWorkspace(client.db, workspaceId).catch(() => undefined);
  await client?.close();
  await shared?.release();
}, 60_000);

async function auth(): Promise<string> {
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
      authorization: await auth(),
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

describe("portable Skill routes", () => {
  test("installs and lists an exact reviewed curated-library Skill", async () => {
    if (!available) return;
    const entry = listSkillLibraryEntries()[0]!;
    const encodedLibraryId = encodeURIComponent(entry.id);

    const drifted = await request(`/skills/library/${encodedLibraryId}/install`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: entry.version,
        expectedContentSha256: "0".repeat(64),
      }),
    });
    expect(drifted.status).toBe(409);

    const installedResponse = await request(`/skills/library/${encodedLibraryId}/install`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: entry.version,
        expectedContentSha256: entry.contentSha256,
      }),
    });
    expect(installedResponse.status).toBe(201);
    const installed = await installedResponse.json();
    expect(installed).toMatchObject({
      capabilityId: `skill:${entry.id}`,
      source: "library",
      version: entry.version,
      sourceCommit: entry.sourceCommit,
      contentSha256: entry.contentSha256,
      status: "installed",
    });

    const listedResponse = await request("/skills");
    expect(listedResponse.status).toBe(200);
    expect(await listedResponse.json()).toEqual({
      skills: [
        expect.objectContaining({
          capabilityId: `skill:${entry.id}`,
          pluginKey: `skill/library/${entry.id}`,
          installationVersion: installed.installationVersion,
          source: "library",
          version: entry.version,
          sourceCommit: entry.sourceCommit,
          contentSha256: entry.contentSha256,
          owners: [
            {
              kind: "direct",
              id: `skill:${entry.id}`,
              removable: true,
            },
          ],
        }),
      ],
    });

    const replayedResponse = await request(`/skills/library/${encodedLibraryId}/install`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: entry.version,
        expectedContentSha256: entry.contentSha256,
      }),
    });
    expect(replayedResponse.status).toBe(200);
    expect(await replayedResponse.json()).toMatchObject({
      capabilityId: `skill:${entry.id}`,
      installationVersion: installed.installationVersion,
      source: "library",
      version: entry.version,
    });

    const updatedResponse = await request(`/skills/library/${encodedLibraryId}/install`, {
      method: "POST",
      body: JSON.stringify({
        expectedVersion: entry.version,
        expectedContentSha256: entry.contentSha256,
        expectedInstallationVersion: installed.installationVersion,
      }),
    });
    expect(updatedResponse.status).toBe(200);
    expect(await updatedResponse.json()).toMatchObject({
      capabilityId: `skill:${entry.id}`,
      installationVersion: installed.installationVersion,
      source: "library",
      version: entry.version,
    });
  }, 60_000);

  test("previews exact content, fences source drift, installs, and OCC-uninstalls", async () => {
    if (!available) return;
    const sourceUrl = "https://skills.sh/acme/skills/release-operator";
    const previewResponse = await request("/skills/preview", {
      method: "POST",
      body: JSON.stringify({ url: sourceUrl }),
    });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview).toMatchObject({
      source: "skills_sh",
      sourceCommit: "a".repeat(40),
      name: "release-operator",
      files: [{ path: "SKILL.md" }],
      installed: false,
      installationVersion: null,
    });

    sourceCommit = "c".repeat(40);
    const drifted = await request("/skills/install", {
      method: "POST",
      body: JSON.stringify({
        url: sourceUrl,
        expectedSourceCommit: preview.sourceCommit,
        expectedContentSha256: preview.contentSha256,
      }),
    });
    expect(drifted.status).toBe(409);

    sourceCommit = "a".repeat(40);
    const installedResponse = await request("/skills/install", {
      method: "POST",
      body: JSON.stringify({
        url: sourceUrl,
        expectedSourceCommit: preview.sourceCommit,
        expectedContentSha256: preview.contentSha256,
      }),
    });
    expect(installedResponse.status).toBe(201);
    const installed = await installedResponse.json();
    expect(installed).toMatchObject({
      source: "skills_sh",
      sourceCommit: preview.sourceCommit,
      contentSha256: preview.contentSha256,
      status: "installed",
    });

    sourceCommit = "b".repeat(40);
    const updatePreview = await request("/skills/preview", {
      method: "POST",
      body: JSON.stringify({ url: sourceUrl }),
    }).then(async (response) => await response.json());
    expect(updatePreview).toMatchObject({
      installed: true,
      installationVersion: installed.installationVersion,
    });
    const missingUpdateFence = await request("/skills/install", {
      method: "POST",
      body: JSON.stringify({
        url: sourceUrl,
        expectedSourceCommit: updatePreview.sourceCommit,
        expectedContentSha256: updatePreview.contentSha256,
      }),
    });
    expect(missingUpdateFence.status).toBe(400);
    const staleUpdate = await request("/skills/install", {
      method: "POST",
      body: JSON.stringify({
        url: sourceUrl,
        expectedSourceCommit: updatePreview.sourceCommit,
        expectedContentSha256: updatePreview.contentSha256,
        expectedInstallationVersion: installed.installationVersion + 1,
      }),
    });
    expect(staleUpdate.status).toBe(409);
    const updatedResponse = await request("/skills/install", {
      method: "POST",
      body: JSON.stringify({
        url: sourceUrl,
        expectedSourceCommit: updatePreview.sourceCommit,
        expectedContentSha256: updatePreview.contentSha256,
        expectedInstallationVersion: installed.installationVersion,
      }),
    });
    expect(updatedResponse.status).toBe(200);
    const updated = await updatedResponse.json();
    expect(updated.installationVersion).toBe(installed.installationVersion + 1);

    const encodedCapabilityId = encodeURIComponent(updated.capabilityId);
    const uninstallPreviewResponse = await request(
      `/skills/${encodedCapabilityId}/uninstall-preview`,
    );
    expect(uninstallPreviewResponse.status).toBe(200);
    const uninstallPreview = await uninstallPreviewResponse.json();
    expect(uninstallPreview).toMatchObject({
      installed: true,
      installationVersion: updated.installationVersion,
      removesRuntimeSkill: true,
    });

    const stale = await request(`/skills/${encodedCapabilityId}`, {
      method: "DELETE",
      body: JSON.stringify({
        expectedInstallationVersion: uninstallPreview.installationVersion + 1,
      }),
    });
    expect(stale.status).toBe(409);

    const removed = await request(`/skills/${encodedCapabilityId}`, {
      method: "DELETE",
      body: JSON.stringify({
        expectedInstallationVersion: uninstallPreview.installationVersion,
      }),
    });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      capabilityId: updated.capabilityId,
      status: "uninstalled",
      remainingOwners: [],
    });
  }, 60_000);
});
