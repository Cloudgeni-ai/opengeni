import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import {
  bootstrapWorkspace,
  createDb,
  deleteWorkspace,
  getPortableSkillUninstallPreview,
  installPortableSkill,
  listInstalledPortableSkills,
  PortableSkillInstallationVersionConflictError,
  PortableSkillInstallationVersionRequiredError,
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
  const adminUrl = process.env.OPENGENI_PORTABLE_SKILLS_TEST_POSTGRES_ADMIN_URL;
  const appUrl = process.env.OPENGENI_PORTABLE_SKILLS_TEST_POSTGRES_APP_URL;
  if ((adminUrl && !appUrl) || (!adminUrl && appUrl)) {
    throw new Error(
      "OPENGENI_PORTABLE_SKILLS_TEST_POSTGRES_ADMIN_URL and OPENGENI_PORTABLE_SKILLS_TEST_POSTGRES_APP_URL must be set together",
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
    shared = await acquireSharedTestDatabase("portable-skills");
  }
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[portable-skills] docker unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
  first = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `portable-skill-account-${crypto.randomUUID()}`,
      accountName: "Portable Skill account",
      workspaceExternalSource: "test",
      workspaceExternalId: `portable-skill-workspace-${crypto.randomUUID()}`,
      workspaceName: "Portable Skill workspace",
      subjectId: "user:portable-skill-owner",
    })
  ).workspaceGrants[0]!;
  second = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: `portable-skill-foreign-account-${crypto.randomUUID()}`,
      accountName: "Foreign account",
      workspaceExternalSource: "test",
      workspaceExternalId: `portable-skill-foreign-workspace-${crypto.randomUUID()}`,
      workspaceName: "Foreign workspace",
      subjectId: "user:portable-skill-foreign",
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

describe("portable Skill persistence", () => {
  test("installs idempotently, isolates tenants, and removes an unowned runtime Skill", async () => {
    if (!available || !client) return;
    const input = skillInput("release-operator");
    const installed = await installPortableSkill(client.db, input);
    const replay = await installPortableSkill(client.db, input);
    expect(replay).toEqual(installed);
    expect(await listInstalledPortableSkills(client.db, first.workspaceId)).toEqual([
      expect.objectContaining({
        capabilityId: input.capabilityId,
        contentSha256: input.contentSha256,
        files: [{ path: "SKILL.md", content: input.files[0]!.content }],
      }),
    ]);
    expect(await listInstalledPortableSkills(client.db, second.workspaceId)).toEqual([]);

    const preview = await getPortableSkillUninstallPreview(
      client.db,
      first.workspaceId,
      input.capabilityId,
    );
    expect(preview).toMatchObject({
      installed: true,
      installationVersion: 1,
      directOwner: { kind: "direct", id: input.capabilityId },
      remainingOwners: [],
      removesRuntimeSkill: true,
    });
    await expect(
      uninstallPortableSkill(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        capabilityId: input.capabilityId,
        expectedInstallationVersion: 2,
      }),
    ).rejects.toBeInstanceOf(PortableSkillInstallationVersionConflictError);
    expect(
      await uninstallPortableSkill(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        capabilityId: input.capabilityId,
        expectedInstallationVersion: 1,
      }),
    ).toEqual({
      capabilityId: input.capabilityId,
      status: "uninstalled",
      remainingOwners: [],
    });
    expect(await listInstalledPortableSkills(client.db, first.workspaceId)).toEqual([]);
  }, 60_000);

  test("removing a direct owner preserves a Skill still owned by a Pack", async () => {
    if (!available || !client || !shared) return;
    const input = skillInput("incident-responder");
    const installed = await installPortableSkill(client.db, input);
    await shared.admin`
      insert into capability_component_owners
        (account_id, workspace_id, facet_installation_id, owner_kind, owner_id, removable)
      values
        (${first.accountId}, ${first.workspaceId}, ${installed.facetInstallationId},
         'pack', 'pack:production-operations', false)
    `;

    const preview = await getPortableSkillUninstallPreview(
      client.db,
      first.workspaceId,
      input.capabilityId,
    );
    expect(preview).toMatchObject({
      installed: true,
      installationVersion: 1,
      remainingOwners: [{ kind: "pack", id: "pack:production-operations", removable: false }],
      removesRuntimeSkill: false,
    });
    expect(
      await uninstallPortableSkill(client.db, {
        accountId: first.accountId,
        workspaceId: first.workspaceId,
        capabilityId: input.capabilityId,
        expectedInstallationVersion: 1,
      }),
    ).toEqual({
      capabilityId: input.capabilityId,
      status: "retained_by_other_owners",
      remainingOwners: [{ kind: "pack", id: "pack:production-operations", removable: false }],
    });
    expect(await listInstalledPortableSkills(client.db, first.workspaceId)).toEqual([
      expect.objectContaining({ capabilityId: input.capabilityId }),
    ]);
  }, 60_000);

  test("requires and validates the current installation version before a direct update", async () => {
    if (!available || !client) return;
    const initial = skillInput("deployment-reviewer");
    const installed = await installPortableSkill(client.db, initial);
    const updated = skillInput("deployment-reviewer");
    updated.sourceCommit = "b".repeat(40);
    updated.sourceUrl = updated.sourceUrl.replace("a".repeat(40), "b".repeat(40));

    await expect(installPortableSkill(client.db, updated)).rejects.toBeInstanceOf(
      PortableSkillInstallationVersionRequiredError,
    );
    await expect(
      installPortableSkill(client.db, { ...updated, expectedInstallationVersion: 9 }),
    ).rejects.toBeInstanceOf(PortableSkillInstallationVersionConflictError);
    expect(
      await installPortableSkill(client.db, {
        ...updated,
        expectedInstallationVersion: installed.installationVersion,
      }),
    ).toMatchObject({
      sourceCommit: "b".repeat(40),
      installationVersion: installed.installationVersion + 1,
    });
  }, 60_000);
});
