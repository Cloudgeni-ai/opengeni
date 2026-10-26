import assert from "node:assert/strict";
import { acquireSharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  bootstrapWorkspace,
  createDb,
  hasWorkspaceManagedSkill,
  listSkillDescriptors,
} from "../../packages/db/src/index";
import { saveSkill } from "../../packages/core/src/domain/skills";

// Disposable real-PG fixture; no provider calls. Compare identical live scope reads.
const shared = await acquireSharedTestDatabase("bench-skill-presence");
if (!shared) throw new Error("Real PostgreSQL is required");
const client = createDb(shared.appUrl);
try {
  const key = crypto.randomUUID();
  const subjectId = `skill-presence-${key}`;
  const grant = (
    await bootstrapWorkspace(client.db, {
      accountExternalSource: "test",
      accountExternalId: key,
      accountName: "Skill presence",
      workspaceExternalSource: "test",
      workspaceExternalId: key,
      workspaceName: "Skill presence",
      subjectId,
    })
  ).workspaceGrants[0]!;
  const context = { accountId: grant.accountId, workspaceId: grant.workspaceId, subjectId };
  let seeded = 0;
  for (const size of [0, 1, 1000]) {
    for (; seeded < size; seeded++) {
      await saveSkill(client.db, {
        ...context,
        actor: { kind: "human", subjectId, principalKind: "human_session" },
        operationId: crypto.randomUUID(),
        skillId: crypto.randomUUID(),
        expectedRevisionId: null,
        expectedScopeVersion: 1,
        stableKey: `presence-${seeded}`,
        files: [
          {
            path: "SKILL.md",
            content: `---\nname: presence-${seeded}\ndescription: Skill presence benchmark\n---\nFixture.`,
          },
        ],
        reason: "Presence benchmark fixture",
      });
    }
    await shared.admin`ANALYZE preference_registry_preferences`;
    await shared.admin`ANALYZE preference_registry_revisions`;
    const samples: Record<"descriptors" | "presence", number[]> = { descriptors: [], presence: [] };
    let descriptorBytes = 0;
    for (let sample = 0; sample < 45; sample++) {
      const order =
        sample % 2
          ? (["descriptors", "presence"] as const)
          : (["presence", "descriptors"] as const);
      for (const variant of order) {
        const start = performance.now();
        const value =
          variant === "descriptors"
            ? await listSkillDescriptors(client.db, context)
            : await hasWorkspaceManagedSkill(client.db, context);
        if (sample >= 5) samples[variant].push(performance.now() - start);
        if (Array.isArray(value)) {
          assert.equal(value.length, size);
          assert.equal(
            value.some((entry) => entry.activationMode === "workspace_managed"),
            size > 0,
          );
          descriptorBytes = Buffer.byteLength(JSON.stringify(value));
        } else assert.equal(value, size > 0);
      }
    }
    console.log(
      JSON.stringify({
        skills: size,
        measuredPairs: 40,
        decodedJsonBytes: {
          descriptors: descriptorBytes,
          presence: Buffer.byteLength(JSON.stringify(size > 0)),
        },
        medianMs: Object.fromEntries(
          Object.entries(samples).map(([name, values]) => [name, values.sort((a, b) => a - b)[20]]),
        ),
        scope:
          "Synthetic local scoped read; decoded JSON bytes, not wire bytes. No transaction-count or live-gain claim.",
      }),
    );
  }
} finally {
  await client.close();
  await shared.release();
}
