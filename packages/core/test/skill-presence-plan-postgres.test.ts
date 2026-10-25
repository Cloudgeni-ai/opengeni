import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  hasWorkspaceManagedSkill,
  installPortableSkill,
  listSkillDescriptors,
  registerDbBinding,
  withWorkspaceSubjectRls,
} from "@opengeni/db";
import * as schema from "../../db/src/schema";
import { LOSSLESS_CONTENT_WRITER_APPLICATION_NAME } from "../../db/src/lossless-json";
import { saveSkill } from "../src/domain/skills";

test("presence projection avoids per-row probe amplification for absent and late matches", async () => {
  const shared = await acquireSharedTestDatabase("skill-presence-plans");
  if (!shared) return;
  const driver = postgres(shared.appUrl, {
    max: 1,
    prepare: false,
    connection: { application_name: LOSSLESS_CONTENT_WRITER_APPLICATION_NAME },
  });
  const db = drizzle(driver, { schema });
  registerDbBinding(db, { rlsStrategy: "force" });
  try {
    const key = crypto.randomUUID();
    const subjectId = `presence-${key}`;
    const grant = (
      await bootstrapWorkspace(db, {
        accountExternalSource: "test",
        accountExternalId: key,
        accountName: "Presence plans",
        workspaceExternalSource: "test",
        workspaceExternalId: key,
        workspaceName: "Presence plans",
        subjectId,
      })
    ).workspaceGrants[0]!;
    const context = { accountId: grant.accountId, workspaceId: grant.workspaceId, subjectId };
    const actor = { kind: "human", subjectId, principalKind: "human_session" } as const;
    const content =
      "---\nname: presence-fixture\ndescription: Presence plan fixture\n---\nFixture.";
    const digest = createHash("sha256").update(content).digest("hex");
    for (let i = 0; i < 1000; i++) {
      await installPortableSkill(db, {
        ...context,
        skillActor: actor,
        capabilityId: `skill:${key}-${i}`,
        pluginKey: `skill/test/${key}-${i}`,
        source: "github",
        sourceUrl: "https://example.test/skills",
        repositoryUrl: "https://example.test/repo",
        sourceCommit: "a".repeat(40),
        sourcePath: `skills/${i}`,
        name: "presence-fixture",
        description: "Plan fixture",
        contentSha256: digest,
        totalBytes: Buffer.byteLength(content),
        activationMode: "session_selected",
        files: [
          {
            path: "SKILL.md",
            content,
            byteSize: Buffer.byteLength(content),
            contentSha256: digest,
          },
        ],
      });
    }
    const [role] =
      await driver`SELECT rolsuper, rolbypassrls, current_setting('row_security') AS rls
      FROM pg_roles WHERE rolname=current_user`;
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false, rls: "on" });
    for (const sample of ["none", "late"] as const) {
      if (sample === "late")
        await saveSkill(db, {
          ...context,
          actor,
          operationId: crypto.randomUUID(),
          skillId: crypto.randomUUID(),
          expectedRevisionId: null,
          expectedScopeVersion: 1,
          stableKey: "zz-managed",
          files: [{ path: "SKILL.md", content }],
          reason: "Late managed fixture",
        });
      await shared.admin`ANALYZE preference_registry_preferences`;
      await shared.admin`ANALYZE preference_registry_revisions`;
      await shared.admin`ANALYZE skill_source_bindings`;
      await shared.admin`ANALYZE capability_plugin_installations`;
      const budgets: Record<string, number> = {};
      for (const reader of [listSkillDescriptors, hasWorkspaceManagedSkill]) {
        const queries: Array<{ query: string; parameters: unknown[] }> = [];
        driver.options.debug = (_id, query, parameters) => queries.push({ query, parameters });
        let value;
        try {
          value = await reader(db, context);
        } finally {
          driver.options.debug = false;
        }
        expect(
          Array.isArray(value)
            ? value.some((entry) => entry.activationMode === "workspace_managed")
            : value,
        ).toBe(sample === "late");
        const captured = queries.filter((query) =>
          query.query.includes("FROM preference_registry_preferences h"),
        );
        expect(captured).toHaveLength(1);
        const query = captured[0]!;
        for (const mode of ["force_custom_plan", "force_generic_plan"]) {
          await withWorkspaceSubjectRls(db, context.workspaceId, subjectId, async (tx) => {
            await tx.execute(sql.raw(`SET LOCAL plan_cache_mode=${mode}`));
            await tx.execute(sql.raw(`PREPARE skill_presence_plan AS ${query.query}`));
            try {
              const args = query.parameters
                .map((parameter) =>
                  parameter === null ? "null" : `'${String(parameter).replaceAll("'", "''")}'`,
                )
                .join(",");
              const rows = await tx.execute(
                sql.raw(
                  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) EXECUTE skill_presence_plan(${args})`,
                ),
              );
              const [plan] = rows[0]!["QUERY PLAN"] as Array<{
                Plan: { "Shared Hit Blocks": number };
                "Execution Time": number;
              }>;
              budgets[`${reader.name}:${mode}`] = plan!.Plan["Shared Hit Blocks"];
              if (process.env.OPENGENI_BENCH_SKILL_PRESENCE === "1")
                console.log(
                  JSON.stringify({
                    sample,
                    reader: reader.name,
                    mode,
                    buffers: plan!.Plan["Shared Hit Blocks"],
                    ms: plan!["Execution Time"],
                  }),
                );
            } finally {
              await tx.execute(sql.raw("DEALLOCATE skill_presence_plan"));
            }
          });
        }
      }
      // EXISTS can prefer repeated nested RLS probes when managed matches are sparse.
      // Allow planner variation, but reject the reproduced multi-fold amplification.
      for (const mode of ["force_custom_plan", "force_generic_plan"]) {
        expect(budgets[`hasWorkspaceManagedSkill:${mode}`]!).toBeLessThan(
          budgets[`listSkillDescriptors:${mode}`]! * 2 + 100,
        );
      }
    }
  } finally {
    await driver.end();
    await shared.release();
  }
}, 180_000);
