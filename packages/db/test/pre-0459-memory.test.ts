// Historical schema coverage only. New runtime Knowledge coverage is in
// unified-knowledge-postgres.test.ts and migration-0459-unified-knowledge.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as dbSchema from "../src/schema";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";
import type { AccessGrant } from "@opengeni/contracts";
import {
  bootstrapWorkspace,
  createKnowledgeMemory,
  getKnowledgeMemory,
  saveWorkspaceMemory,
  correctWorkspaceMemory,
  searchWorkspaceMemories,
  resolveWorkspaceMemoryBlock,
  updateKnowledgeMemory,
  hashMemoryText,
  MEMORY_VISIBLE_RECORD_CAP,
  type MemoryEmbedder,
  createDb,
  dbSql,
  listKnowledgeMemories,
} from "@opengeni/db";

describe("pre-0459 Memory storage compatibility", () => {
  let owned: OwnerMigratedTestDatabase;
  let dbClient: ReturnType<typeof createDb>;
  let services: { databaseUrl: string };
  beforeAll(async () => {
    const acquired = await acquireOwnerMigratedTestDatabase("historical-memory");
    if (!acquired) throw new Error("Historical Memory verification requires PostgreSQL");
    owned = acquired;
    const owner = postgres(owned.ownerUrl, { max: 1 });
    try {
      await owner`CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`;
      await owner`INSERT INTO schema_migrations(name) VALUES('0459_unified_knowledge.sql')`;
      await migrate(owned.ownerUrl);
    } finally {
      await owner.end();
    }
    services = { databaseUrl: owned.adminUrl };
    dbClient = createDb(owned.adminUrl);
  }, 900_000);
  afterAll(async () => {
    await dbClient?.close();
    await owned?.release();
  }, 180_000);
  test("RLS policies isolate knowledge memories for a non-owner app role", async () => {
    const appRoleUrl = await createRlsAppRole(dbClient.db, services.databaseUrl);
    const appDbClient = createDb(appRoleUrl);
    try {
      const grantA = await testGrant(dbClient.db);
      const grantB = await testGrant(dbClient.db);
      await createKnowledgeMemory(dbClient.db, {
        accountId: grantB.accountId,
        workspaceId: grantB.workspaceId,
        status: "approved",
        kind: "decision",
        text: "Workspace B private decision",
      });

      const hidden = await appDbClient.db.execute(
        dbSql<{
          count: string;
        }>`select count(*)::text as count from knowledge_memories`,
      );
      expect(Number(hidden[0]?.count ?? 0)).toBe(0);

      const created = await createKnowledgeMemory(appDbClient.db, {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        kind: "semantic",
        text: "Workspace A reviewed context",
      });
      expect(created.workspaceId).toBe(grantA.workspaceId);

      const visible = await listKnowledgeMemories(appDbClient.db, grantA.workspaceId);
      expect(visible.map((memory) => memory.workspaceId)).toEqual([grantA.workspaceId]);

      await expect(
        createKnowledgeMemory(appDbClient.db, {
          accountId: grantA.accountId,
          workspaceId: grantB.workspaceId,
          text: "Mismatched memory",
        }),
      ).rejects.toThrow();
    } finally {
      await appDbClient.close();
    }
  });

  // ---- Workspace Memory V1 (M1) -------------------------------------------

  // Deterministic per-text 3072-d vector (same text → same vector), enough to
  // exercise the vector arm without pulling @opengeni/documents into the harness.
  const deterministicVector = (text: string): number[] => {
    const vec = new Array<number>(3072);
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    for (let i = 0; i < 3072; i += 1) {
      h ^= i + 1;
      h = Math.imul(h, 16777619) >>> 0;
      vec[i] = ((h >>> 0) / 4294967295) * 2 - 1;
    }
    return vec;
  };
  const memoryEmbedder: MemoryEmbedder = {
    model: "test-deterministic-3072",
    embedMany: async (texts: string[]) => texts.map(deterministicVector),
  };
  const enableWorkspaceMemory = async (workspaceId: string) => {
    await dbClient.db.execute(
      dbSql`update workspaces set settings = '{"memoryEnabled":true}'::jsonb where id = ${workspaceId}`,
    );
  };
  // Every text embeds to the SAME non-zero vector → any two distinct texts are
  // cosine-identical, which exercises the near-dup gate (distinct hash, sim = 1).
  const collidingEmbedder = (model: string): MemoryEmbedder => {
    const fixed = new Array(3072).fill(0.0125);
    return {
      model,
      embedMany: async (texts: string[]) => texts.map(() => fixed),
    };
  };
  const throwingEmbedder: MemoryEmbedder = {
    model: "throwing-embedder",
    embedMany: async () => {
      throw new Error("embedder unavailable");
    },
  };

  test("AC-3/AC-5/AC-6: save embeds, hybrid search finds it, and usage counters bump", async () => {
    const grant = await testGrant(dbClient.db);
    const saved = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Staging deploys from main only, via the opengeni-ops workflow.",
        kind: "procedural",
      },
      memoryEmbedder,
    );
    expect(saved.deduped).toBe(false);
    expect(saved.embedded).toBe(true);
    expect(saved.memory.status).toBe("active");
    expect(saved.memory.usageCount).toBe(0);

    const hits = await searchWorkspaceMemories(
      dbClient.db,
      grant.workspaceId,
      { query: "how do we deploy staging" },
      memoryEmbedder,
    );
    expect(hits.map((hit) => hit.memory.id)).toContain(saved.memory.id);
    const hit = hits.find((entry) => entry.memory.id === saved.memory.id)!;
    expect(hit.score).toBeGreaterThan(0);
    // usage_count bumped exactly once for the returned row; updated_at untouched.
    expect(hit.memory.usageCount).toBe(1);
    expect(hit.memory.lastUsedAt).not.toBeNull();
    expect(hit.memory.updatedAt).toBe(saved.memory.updatedAt);
  });

  test("AC-3: exact-duplicate save is a NOOP returning the existing id", async () => {
    const grant = await testGrant(dbClient.db);
    const first = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Prefer Terraform over Pulumi.",
      },
      memoryEmbedder,
    );
    const again = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "  prefer   TERRAFORM over pulumi.  ",
      },
      memoryEmbedder,
    );
    expect(again.deduped).toBe(true);
    expect(again.dedupeReason).toBe("exact");
    expect(again.memory.id).toBe(first.memory.id);
    const all = await listKnowledgeMemories(dbClient.db, grant.workspaceId, {
      kind: "semantic",
    });
    expect(all.filter((memory) => memory.status === "active")).toHaveLength(1);
  });

  test("concurrent exact-duplicate saves converge on one visible row", async () => {
    const grant = await testGrant(dbClient.db);
    const text = "Concurrent saves normalize to one exact memory.";
    const [first, second] = await Promise.all([
      saveWorkspaceMemory(
        dbClient.db,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          text,
        },
        memoryEmbedder,
      ),
      saveWorkspaceMemory(
        dbClient.db,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          text: " concurrent   SAVES normalize to one exact memory. ",
        },
        memoryEmbedder,
      ),
    ]);

    expect(new Set([first.memory.id, second.memory.id]).size).toBe(1);
    expect([first.deduped, second.deduped].filter(Boolean)).toHaveLength(1);
    const [{ visibleCount } = { visibleCount: 0 }] = await dbClient.db.execute<{
      visibleCount: number;
    }>(dbSql`
      select count(*)::int as "visibleCount" from knowledge_memories
      where workspace_id = ${grant.workspaceId}::uuid
        and status in ('active', 'approved')
        and text_hash = ${hashMemoryText(text)}
    `);
    expect(Number(visibleCount)).toBe(1);
  });

  test("activating a proposed memory that exact-dups a visible row fails actionably", async () => {
    const grant = await testGrant(dbClient.db);
    const active = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Production incidents page the SRE rotation.",
      },
      memoryEmbedder,
    );
    const proposed = await createKnowledgeMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      status: "proposed",
      text: " production   INCIDENTS page the SRE rotation. ",
    });

    await expect(
      updateKnowledgeMemory(
        dbClient.db,
        grant.workspaceId,
        proposed.id,
        {
          status: "active",
        },
        memoryEmbedder,
      ),
    ).rejects.toThrow(new RegExp(`duplicates an existing visible memory.*${active.memory.id}`));
  });

  test("exact-duplicate save ignores proposed rows the agent cannot see", async () => {
    const grant = await testGrant(dbClient.db);
    const text = "Use staged rollout windows for risky API changes.";
    const [proposed] = await dbClient.db
      .insert(dbSchema.knowledgeMemories)
      .values({
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        status: "proposed",
        kind: "semantic",
        scope: "workspace",
        text,
        textHash: hashMemoryText(text),
      })
      .returning({ id: dbSchema.knowledgeMemories.id });
    const saved = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: " use   STAGED rollout windows for risky API changes. ",
      },
      memoryEmbedder,
    );
    expect(saved.deduped).toBe(false);
    expect(saved.memory.status).toBe("active");
    expect(saved.memory.id).not.toBe(proposed?.id);
  });

  test("exact-duplicate save dedupes against approved curated memory", async () => {
    const grant = await testGrant(dbClient.db);
    const curated = await createKnowledgeMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      status: "approved",
      kind: "semantic",
      text: "Production deploys require a release manager approval.",
    });
    const saved = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: " production  deploys REQUIRE a release manager approval. ",
      },
      memoryEmbedder,
    );
    expect(saved.deduped).toBe(true);
    expect(saved.dedupeReason).toBe("exact");
    expect(saved.memory.id).toBe(curated.id);
  });

  test("autonomous Memory cannot mutate approved reviewed Knowledge", async () => {
    const grant = await testGrant(dbClient.db);
    const curated = await createKnowledgeMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      status: "approved",
      kind: "decision",
      text: "Production changes require a reviewed rollout plan.",
    });

    await expect(
      saveWorkspaceMemory(
        dbClient.db,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          text: "Production changes may skip the reviewed rollout plan.",
          kind: "decision",
          replacesId: curated.id,
          origin: "agent",
        },
        memoryEmbedder,
      ),
    ).rejects.toThrow(/Autonomous Memory can replace only active agent-writable records/i);

    await expect(
      correctWorkspaceMemory(
        dbClient.db,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          id: curated.id,
          reason: "agent attempted archival",
          origin: "agent",
        },
        memoryEmbedder,
      ),
    ).rejects.toThrow(/Autonomous Memory can archive only active agent-writable records/i);

    await expect(
      correctWorkspaceMemory(
        dbClient.db,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          id: curated.id,
          replacementText: "Production changes never require a rollout plan.",
          origin: "agent",
        },
        memoryEmbedder,
      ),
    ).rejects.toThrow(/Autonomous Memory can correct only active agent-writable records/i);

    expect(await getKnowledgeMemory(dbClient.db, grant.workspaceId, curated.id)).toMatchObject({
      status: "approved",
      text: "Production changes require a reviewed rollout plan.",
    });
  });

  test("AC-3: near-duplicate (cosine >= threshold) save is a NOOP", async () => {
    const grant = await testGrant(dbClient.db);
    const embedder = collidingEmbedder("colliding-model-3072");
    const first = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "The primary database lives in West Europe.",
      },
      embedder,
    );
    const near = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Totally different words but identical embedding.",
      },
      embedder,
    );
    expect(near.deduped).toBe(true);
    expect(near.dedupeReason).toBe("near");
    expect(near.memory.id).toBe(first.memory.id);
  });

  test("AC-3: over-length and empty text are rejected actionably", async () => {
    const grant = await testGrant(dbClient.db);
    await expect(
      saveWorkspaceMemory(
        dbClient.db,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          text: "x".repeat(5000),
        },
        memoryEmbedder,
      ),
    ).rejects.toThrow(/too long/i);
    await expect(
      saveWorkspaceMemory(
        dbClient.db,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          text: "   \n\t  ",
        },
        memoryEmbedder,
      ),
    ).rejects.toThrow(/empty/i);
  });

  test("AC-3: token-shaped and PEM-looking memory text is stored exactly", async () => {
    const grant = await testGrant(dbClient.db);
    const tokenShaped = ["ghp", "synthetic", "memory", "1234567890"].join("_");
    const text = `deploy uses ${tokenShaped} and a -----BEGIN RSA PRIVATE KEY-----\nMIIsecret\n-----END RSA PRIVATE KEY-----`;
    const saved = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text,
      },
      memoryEmbedder,
    );
    expect(saved.memory.text).toBe(text);
  });

  test("AC-4: replaces_id supersedes the old record and links both ways", async () => {
    const grant = await testGrant(dbClient.db);
    const old = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Staging runs on the gecko cluster.",
        kind: "semantic",
      },
      memoryEmbedder,
    );
    const next = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Staging runs on the neu cluster now.",
        kind: "semantic",
        replacesId: old.memory.id,
      },
      memoryEmbedder,
    );
    expect(next.superseded?.id).toBe(old.memory.id);
    expect(next.superseded?.status).toBe("superseded");
    expect(next.superseded?.supersededById).toBe(next.memory.id);
    expect(next.superseded?.validUntil).not.toBeNull();
    expect(next.memory.supersedesId).toBe(old.memory.id);
    // Superseded records never appear in search or the working set.
    const hits = await searchWorkspaceMemories(
      dbClient.db,
      grant.workspaceId,
      { query: "staging cluster" },
      memoryEmbedder,
    );
    expect(hits.map((hit) => hit.memory.id)).not.toContain(old.memory.id);
  });

  test("AC-4: replaces_id accepts a short id and rejects an unknown id", async () => {
    const grant = await testGrant(dbClient.db);
    const old = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Old fact to be replaced by short id.",
      },
      memoryEmbedder,
    );
    const next = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "New fact via short id replacement.",
        replacesId: old.memory.id.slice(0, 8),
      },
      memoryEmbedder,
    );
    expect(next.superseded?.id).toBe(old.memory.id);
    await expect(
      saveWorkspaceMemory(
        dbClient.db,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          text: "Points at nothing.",
          replacesId: "ffffffff",
        },
        memoryEmbedder,
      ),
    ).rejects.toThrow(/does not match/i);
  });

  test("short memory id resolution ignores terminal rows but remains ambiguous across live rows", async () => {
    const grant = await testGrant(dbClient.db);
    const activeId = "abcddcba-0000-4000-8000-000000000001";
    const archivedId = "abcddcba-0000-4000-8000-000000000002";
    await dbClient.db.insert(dbSchema.knowledgeMemories).values([
      {
        id: activeId,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        status: "active",
        kind: "semantic",
        scope: "workspace",
        text: "Active row with a colliding short id.",
        textHash: hashMemoryText("Active row with a colliding short id."),
      },
      {
        id: archivedId,
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        status: "archived",
        kind: "semantic",
        scope: "workspace",
        text: "Archived row with the same short id.",
        textHash: hashMemoryText("Archived row with the same short id."),
      },
    ]);

    const archived = await correctWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        id: activeId.slice(0, 8),
        reason: "terminal collision should not block the live row",
      },
      memoryEmbedder,
    );
    expect(archived.action).toBe("archived");
    expect(archived.memory.id).toBe(activeId);
    expect(await getKnowledgeMemory(dbClient.db, grant.workspaceId, archivedId)).toMatchObject({
      status: "archived",
    });

    const ambiguous = await testGrant(dbClient.db);
    const firstLiveId = "feedcafe-0000-4000-8000-000000000001";
    const secondLiveId = "feedcafe-0000-4000-8000-000000000002";
    await dbClient.db.insert(dbSchema.knowledgeMemories).values([
      {
        id: firstLiveId,
        accountId: ambiguous.accountId,
        workspaceId: ambiguous.workspaceId,
        status: "active",
        kind: "semantic",
        scope: "workspace",
        text: "First live row with a colliding short id.",
        textHash: hashMemoryText("First live row with a colliding short id."),
      },
      {
        id: secondLiveId,
        accountId: ambiguous.accountId,
        workspaceId: ambiguous.workspaceId,
        status: "approved",
        kind: "semantic",
        scope: "workspace",
        text: "Second live row with a colliding short id.",
        textHash: hashMemoryText("Second live row with a colliding short id."),
      },
    ]);
    await expect(
      correctWorkspaceMemory(
        dbClient.db,
        {
          accountId: ambiguous.accountId,
          workspaceId: ambiguous.workspaceId,
          id: firstLiveId.slice(0, 8),
          reason: "still ambiguous across live rows",
        },
        memoryEmbedder,
      ),
    ).rejects.toThrow(/memory_search.*full id/i);
  });

  test("AC-4: correct without replacement archives; with replacement supersedes", async () => {
    const grant = await testGrant(dbClient.db);
    const a = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "A memory to archive.",
      },
      memoryEmbedder,
    );
    const archived = await correctWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        id: a.memory.id,
        reason: "no longer true",
      },
      memoryEmbedder,
    );
    expect(archived.action).toBe("archived");
    expect(archived.memory.status).toBe("archived");
    expect(archived.replacement).toBeNull();

    const b = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "A memory to be corrected.",
        kind: "decision",
      },
      memoryEmbedder,
    );
    const corrected = await correctWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        id: b.memory.id,
        replacementText: "The corrected decision.",
      },
      memoryEmbedder,
    );
    expect(corrected.action).toBe("superseded");
    expect(corrected.memory.id).toBe(b.memory.id);
    expect(corrected.memory.status).toBe("superseded");
    expect(corrected.replacement?.text).toBe("The corrected decision.");
    // Correction inherits the old record's kind.
    expect(corrected.replacement?.kind).toBe("decision");
  });

  test("replacing with text that exact-dedups another live row retires the old row", async () => {
    const grant = await testGrant(dbClient.db);
    const existing = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Staging deploys from main only.",
        kind: "procedural",
      },
      memoryEmbedder,
    );
    const old = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Staging deploys from develop.",
        kind: "procedural",
      },
      memoryEmbedder,
    );

    const corrected = await correctWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        id: old.memory.id,
        replacementText: "  staging   deploys FROM main only. ",
      },
      memoryEmbedder,
    );

    expect(corrected.action).toBe("superseded");
    expect(corrected.memory.id).toBe(old.memory.id);
    expect(corrected.memory.status).toBe("superseded");
    expect(corrected.memory.supersededById).toBe(existing.memory.id);
    expect(corrected.replacement?.id).toBe(existing.memory.id);
    expect(corrected.replacement?.status).toBe("active");
    expect(await getKnowledgeMemory(dbClient.db, grant.workspaceId, old.memory.id)).toMatchObject({
      status: "superseded",
      supersededById: existing.memory.id,
    });
  });

  test("replacing with text that near-dedups another live row retires the old row", async () => {
    const grant = await testGrant(dbClient.db);
    const embedder = collidingEmbedder("near-replacement-model-3072");
    const existing = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Production database failover uses the west-europe replica.",
        kind: "semantic",
      },
      embedder,
    );
    const old = await saveWorkspaceMemory(dbClient.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      text: "Production database failover uses the north-europe replica.",
      kind: "semantic",
    });

    const corrected = await correctWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        id: old.memory.id,
        replacementText: "Different words that collide with the existing vector.",
      },
      embedder,
    );

    expect(corrected.action).toBe("superseded");
    expect(corrected.memory.id).toBe(old.memory.id);
    expect(corrected.memory.supersededById).toBe(existing.memory.id);
    expect(corrected.replacement?.id).toBe(existing.memory.id);
    expect(await getKnowledgeMemory(dbClient.db, grant.workspaceId, old.memory.id)).toMatchObject({
      status: "superseded",
      supersededById: existing.memory.id,
    });
  });

  test("replacing with text that only dedups the replaces_id row updates that row in place", async () => {
    const grant = await testGrant(dbClient.db);
    const old = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Prefer Azure OpenAI for default embeddings.",
        kind: "preference",
      },
      memoryEmbedder,
    );

    const corrected = await correctWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        id: old.memory.id,
        replacementText: "  prefer   AZURE OpenAI for default embeddings. ",
      },
      memoryEmbedder,
    );

    expect(corrected.action).toBe("updated");
    expect(corrected.memory.id).toBe(old.memory.id);
    expect(corrected.memory.status).toBe("active");
    expect(corrected.memory.text).toBe("  prefer   AZURE OpenAI for default embeddings. ");
    expect(corrected.memory.supersededById).toBeNull();
    expect(corrected.replacement).toBeNull();
    expect(await getKnowledgeMemory(dbClient.db, grant.workspaceId, old.memory.id)).toMatchObject({
      status: "active",
      text: "  prefer   AZURE OpenAI for default embeddings. ",
      supersededById: null,
    });
  });

  test("in-place replaces_id update preserves embedding when normalized text is unchanged and applies metadata", async () => {
    const grant = await testGrant(dbClient.db);
    const old = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Prefer Azure OpenAI for default embeddings.",
        kind: "preference",
      },
      memoryEmbedder,
    );
    const [before] = await dbClient.db.execute<{
      embeddingText: string | null;
      embeddingModel: string | null;
    }>(dbSql`
      select embedding::text as "embeddingText", embedding_model as "embeddingModel"
      from knowledge_memories
      where id = ${old.memory.id}
    `);
    expect(before?.embeddingText).toBeTruthy();
    expect(before?.embeddingModel).toBe("test-deterministic-3072");

    const updated = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "  prefer   AZURE OpenAI for default embeddings. ",
        replacesId: old.memory.id,
        kind: "decision",
        confidence: 0.84,
        pinned: true,
      },
      throwingEmbedder,
    );

    expect(updated.updated).toBe(true);
    expect(updated.memory.id).toBe(old.memory.id);
    expect(updated.memory.kind).toBe("decision");
    expect(updated.memory.confidence).toBe(0.84);
    expect(updated.memory.pinned).toBe(true);
    const [after] = await dbClient.db.execute<{
      embeddingText: string | null;
      embeddingModel: string | null;
    }>(dbSql`
      select embedding::text as "embeddingText", embedding_model as "embeddingModel"
      from knowledge_memories
      where id = ${old.memory.id}
    `);
    expect(after?.embeddingText).toBe(before?.embeddingText);
    expect(after?.embeddingModel).toBe(before?.embeddingModel);
  });

  test("in-place replaces_id update stamps origin only when metadata has none", async () => {
    const grant = await testGrant(dbClient.db);
    const old = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Keep existing origin metadata on self-match updates.",
      },
      memoryEmbedder,
    );
    expect(old.memory.metadata.origin).toBeUndefined();

    const stamped = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: " keep existing ORIGIN metadata on self-match updates. ",
        replacesId: old.memory.id,
        origin: "agent",
      },
      memoryEmbedder,
    );
    expect(stamped.memory.id).toBe(old.memory.id);
    expect(stamped.memory.metadata.origin).toBe("agent");

    const preserved = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Keep existing origin metadata on self-match updates.",
        replacesId: old.memory.id,
        origin: "human",
      },
      memoryEmbedder,
    );
    expect(preserved.memory.id).toBe(old.memory.id);
    expect(preserved.memory.metadata.origin).toBe("agent");
  });

  test("in-place replaces_id update clears stale embedding when text changes and embedding fails", async () => {
    const grant = await testGrant(dbClient.db);
    const old = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "The deployment runbook lives in Confluence.",
      },
      memoryEmbedder,
    );
    const changedText = "The deployment runbook lives in Notion.";
    // Force an exact self-match while the stored text still differs, exercising
    // the in-place branch's stale-vector handling with a failing embedder.
    await dbClient.db.execute(dbSql`
      update knowledge_memories
      set text_hash = ${hashMemoryText(changedText)}
      where id = ${old.memory.id}
    `);

    const updated = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: changedText,
        replacesId: old.memory.id,
      },
      throwingEmbedder,
    );

    expect(updated.updated).toBe(true);
    expect(updated.memory.id).toBe(old.memory.id);
    expect(updated.memory.text).toBe(changedText);
    const [row] = await dbClient.db.execute<{
      embeddingText: string | null;
      embeddingModel: string | null;
    }>(dbSql`
      select embedding::text as "embeddingText", embedding_model as "embeddingModel"
      from knowledge_memories
      where id = ${old.memory.id}
    `);
    // The old vector described the Confluence text; after a failed embed for
    // the Notion text it must be cleared so vector search cannot hit stale meaning.
    expect(row?.embeddingText).toBeNull();
    expect(row?.embeddingModel).toBeNull();
  });

  test("AC-5: keyword fallback works when the embedder throws", async () => {
    const grant = await testGrant(dbClient.db);
    const saved = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "The incident runbook lives in Notion under Operations.",
      },
      memoryEmbedder,
    );
    const hits = await searchWorkspaceMemories(
      dbClient.db,
      grant.workspaceId,
      { query: "incident runbook" },
      throwingEmbedder,
    );
    expect(hits.map((hit) => hit.memory.id)).toContain(saved.memory.id);
    expect(hits.find((hit) => hit.memory.id === saved.memory.id)?.matchType).toBe("keyword");
  });

  test("AC-2: RLS isolates memory save/search/correct across workspaces", async () => {
    const grantA = await testGrant(dbClient.db);
    const grantB = await testGrant(dbClient.db);
    const inA = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grantA.accountId,
        workspaceId: grantA.workspaceId,
        text: "Workspace A only secret plan.",
      },
      memoryEmbedder,
    );
    // Search scoped to B never sees A's row.
    const bHits = await searchWorkspaceMemories(
      dbClient.db,
      grantB.workspaceId,
      { query: "secret plan" },
      memoryEmbedder,
    );
    expect(bHits).toHaveLength(0);
    // Correcting A's id under B's workspace is a not-found (RLS-invisible).
    await expect(
      correctWorkspaceMemory(
        dbClient.db,
        {
          accountId: grantB.accountId,
          workspaceId: grantB.workspaceId,
          id: inA.memory.id,
        },
        memoryEmbedder,
      ),
    ).rejects.toThrow(/not found/i);
  });

  test("AC-3: per-workspace visible-record cap rejects further saves", async () => {
    const grant = await testGrant(dbClient.db);
    // Bulk-seed exactly the visible cap in one statement (fast), including an
    // approved row so saveWorkspaceMemory must count active ∪ approved.
    const activeFillCount = MEMORY_VISIBLE_RECORD_CAP - 1;
    await dbClient.db.execute(dbSql`
      insert into knowledge_memories (account_id, workspace_id, status, kind, scope, text, text_hash)
      select ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, 'active', 'semantic', 'workspace',
             'capfill ' || g, 'caphash-' || g
      from generate_series(1, ${activeFillCount}) as g
      union all
      select ${grant.accountId}::uuid, ${grant.workspaceId}::uuid, 'approved', 'semantic', 'workspace',
             'approved capfill', 'approved-caphash'
    `);
    await expect(
      saveWorkspaceMemory(
        dbClient.db,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          text: "One over the cap.",
        },
        memoryEmbedder,
      ),
    ).rejects.toThrow(/full/i);

    const [victim] = await dbClient.db.execute<{ id: string }>(dbSql`
      select id from knowledge_memories
      where workspace_id = ${grant.workspaceId}::uuid and status = 'active'
      order by text
      limit 1
    `);
    expect(victim?.id).toBeTruthy();
    const replacement = await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "At-cap replacement succeeds by retiring one active row.",
        replacesId: victim!.id,
      },
      memoryEmbedder,
    );
    expect(replacement.deduped).toBe(false);
    expect(replacement.superseded?.id).toBe(victim!.id);
    expect(replacement.memory.status).toBe("active");

    const [{ visibleCount } = { visibleCount: 0 }] = await dbClient.db.execute<{
      visibleCount: number;
    }>(dbSql`
      select count(*)::int as "visibleCount" from knowledge_memories
      where workspace_id = ${grant.workspaceId}::uuid and status in ('active', 'approved')
    `);
    expect(Number(visibleCount)).toBe(MEMORY_VISIBLE_RECORD_CAP);
  });

  test("AC-7: working-set block reflects the memory setting and record state", async () => {
    const grant = await testGrant(dbClient.db);
    // Setting off → null (injection no-ops) even with records present.
    await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Prefer Terraform for infra.",
        kind: "preference",
      },
      memoryEmbedder,
    );
    expect(await resolveWorkspaceMemoryBlock(dbClient.db, grant.workspaceId)).toBeNull();

    await enableWorkspaceMemory(grant.workspaceId);
    await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "Staging deploys from main.",
        kind: "semantic",
      },
      memoryEmbedder,
    );
    await saveWorkspaceMemory(
      dbClient.db,
      {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        text: "A one-off thing that happened.",
        kind: "episodic",
      },
      memoryEmbedder,
    );
    // Enabled with an absent memoryPromptMode → the retrieval_only default
    // default: no standing block even though records exist.
    expect(await resolveWorkspaceMemoryBlock(dbClient.db, grant.workspaceId)).toBeNull();

    // Explicit legacy_standing is the rollback opt-out and restores the block.
    await dbClient.db.execute(dbSql`
      update workspaces
      set settings = settings || '{"memoryPromptMode":"legacy_standing"}'::jsonb
      where id = ${grant.workspaceId}::uuid
    `);
    // The standing block is retired: even a workspace that stored the old
    // opt-out composes nothing into the prompt. The rows themselves are
    // untouched and still reachable through search.
    expect(await resolveWorkspaceMemoryBlock(dbClient.db, grant.workspaceId)).toBeNull();

    // Retrieval-only removes the broad block, but all legacy Memory kinds remain
    // explicitly searchable as non-authoritative historical context.
    await dbClient.db.execute(dbSql`
      update workspaces
      set settings = settings || '{"memoryPromptMode":"retrieval_only"}'::jsonb
      where id = ${grant.workspaceId}::uuid
    `);
    expect(await resolveWorkspaceMemoryBlock(dbClient.db, grant.workspaceId)).toBeNull();
    const agentSearch = await searchWorkspaceMemories(
      dbClient.db,
      grant.workspaceId,
      {
        query: "Prefer Terraform",
        kind: "preference",
        mode: "keyword",
        agentPromptMode: "retrieval_only",
      },
      memoryEmbedder,
    );
    expect(agentSearch.map((result) => result.memory.text)).toContain(
      "Prefer Terraform for infra.",
    );
    const humanAuditSearch = await searchWorkspaceMemories(
      dbClient.db,
      grant.workspaceId,
      { query: "Prefer Terraform", kind: "preference", mode: "keyword" },
      memoryEmbedder,
    );
    expect(humanAuditSearch.map((result) => result.memory.text)).toContain(
      "Prefer Terraform for infra.",
    );

    // Enabled but empty under legacy_standing → the empty-state bootstrap
    // block, not null.
    const empty = await testGrant(dbClient.db);
    await enableWorkspaceMemory(empty.workspaceId);
    await dbClient.db.execute(dbSql`
      update workspaces
      set settings = settings || '{"memoryPromptMode":"legacy_standing"}'::jsonb
      where id = ${empty.workspaceId}::uuid
    `);
    expect(await resolveWorkspaceMemoryBlock(dbClient.db, empty.workspaceId)).toBeNull();
  });
});

async function testGrant(db: ReturnType<typeof createDb>["db"]): Promise<AccessGrant> {
  const id = crypto.randomUUID();
  const context = await bootstrapWorkspace(db, {
    accountExternalSource: "test:db",
    accountExternalId: `account:${id}`,
    accountName: "DB integration account",
    workspaceExternalSource: "test:db",
    workspaceExternalId: `workspace:${id}`,
    workspaceName: "DB integration workspace",
    subjectId: `test:db:${id}`,
    subjectLabel: "DB integration",
  });
  const grant = context.workspaceGrants[0];
  if (!grant) {
    throw new Error("DB test did not create a workspace grant");
  }
  return grant;
}

async function createRlsAppRole(
  db: ReturnType<typeof createDb>["db"],
  ownerUrl: string,
): Promise<string> {
  const role = `opengeni_rls_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const password = `pw_${crypto.randomUUID().replace(/-/g, "")}`;
  await db.execute(dbSql.raw(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`));
  await db.execute(dbSql.raw(`GRANT USAGE ON SCHEMA public TO "${role}"`));
  await db.execute(dbSql.raw(`GRANT USAGE ON SCHEMA opengeni_private TO "${role}"`));
  await db.execute(
    dbSql.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`),
  );
  await db.execute(
    dbSql.raw(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO "${role}"`),
  );
  // Match the runtime role's exact target-schema-local capabilities. These
  // functions are intentionally excluded from the broad private helper grant
  // and remain unavailable to PUBLIC. The session reference helper and xAI
  // validator are invoker-rights; the latter evaluates immutable snapshot
  // CHECK constraints on ordinary session inserts.
  await db.execute(
    dbSql.raw(
      `GRANT EXECUTE ON FUNCTION public.session_private_actor_visible(uuid, uuid, uuid, text) TO "${role}"`,
    ),
  );
  await db.execute(
    dbSql.raw(
      `GRANT EXECUTE ON FUNCTION public.session_reference_visible(uuid, uuid, uuid) TO "${role}"`,
    ),
  );
  await db.execute(
    dbSql.raw(
      `GRANT EXECUTE ON FUNCTION public.lock_nested_agent_depth_configuration() TO "${role}"`,
    ),
  );
  await db.execute(
    dbSql.raw(
      `GRANT EXECUTE ON FUNCTION public.xai_provider_account_authority_snapshot_v1_valid(jsonb) TO "${role}"`,
    ),
  );
  const url = new URL(ownerUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}
