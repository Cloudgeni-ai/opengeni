// seed-session-rail — populate the left session rail with a dense nested forest
// for UI/UX iteration (scroll, expand/collapse, pins, depth clamp, long titles).
//
// Unlike the workbench seeds (real agent turns into a sandbox), this inserts
// sessions directly via @opengeni/db so nesting is possible — public createSession
// cannot set parentSessionId (only a worker-signed spawn claim can).
//
// Run (stack up). Prefer --env-file=/dev/null so a stale .env :5432 URL cannot
// override the remapped compose port (`bun run dev` often uses 6432+):
//   OPENGENI_DATABASE_URL=postgres://opengeni_app:opengeni_app@127.0.0.1:6432/opengeni \
//     bun --env-file=/dev/null test/e2e/seed/seed-session-rail.ts
//
// Env (optional):
//   OPENGENI_SEED_BASE_URL / OPENGENI_SEED_WORKSPACE_ID / OPENGENI_SEED_ACCOUNT_ID
//   OPENGENI_SEED_SUBJECT_ID (default: from /v1/access/me)
//   OPENGENI_SEED_WEB_URL
//   OPENGENI_SEED_RAIL_COUNT (soft target, default ~110)
import {
  createDb,
  createSession,
  setSessionPin,
  updateSessionTitle,
  withRlsContext,
  type Database,
  type Session,
} from "@opengeni/db";
import { and, eq, inArray } from "drizzle-orm";
import { sessions } from "@opengeni/db/schema";
import { BASE_URL, resolveWorkspaceId, WEB_URL } from "./harness";

const ORIGIN = "session-rail-seed";
const BATCH = `rail-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const SUBJECT = process.env.OPENGENI_SEED_SUBJECT_ID;
const TARGET = Number(process.env.OPENGENI_SEED_RAIL_COUNT ?? "110");

type AccessMe = {
  subjectId?: string;
  defaultWorkspaceId?: string;
  workspaceGrants?: Array<{ workspaceId: string; accountId: string; subjectId: string }>;
};

async function resolveIdentity(): Promise<{
  workspaceId: string;
  accountId: string;
  subjectId: string;
}> {
  const workspaceId = process.env.OPENGENI_SEED_WORKSPACE_ID ?? (await resolveWorkspaceId());
  const envAccount = process.env.OPENGENI_SEED_ACCOUNT_ID;
  if (envAccount && SUBJECT) {
    return { workspaceId, accountId: envAccount, subjectId: SUBJECT };
  }
  const res = await fetch(`${BASE_URL}/v1/access/me`, {
    headers: process.env.OPENGENI_SEED_API_KEY
      ? { Authorization: `Bearer ${process.env.OPENGENI_SEED_API_KEY}` }
      : {},
  });
  if (!res.ok) {
    throw new Error(`access/me failed HTTP ${res.status}; set SEED account/subject env vars`);
  }
  const me = (await res.json()) as AccessMe;
  const grant =
    me.workspaceGrants?.find((g) => g.workspaceId === workspaceId) ?? me.workspaceGrants?.[0];
  if (!grant) throw new Error("access/me has no workspace grant for seed target");
  return {
    workspaceId: grant.workspaceId,
    accountId: grant.accountId,
    subjectId: SUBJECT ?? grant.subjectId ?? me.subjectId ?? "dev",
  };
}

function resolveDatabaseUrl(): string {
  if (process.env.OPENGENI_DATABASE_URL) return process.env.OPENGENI_DATABASE_URL;
  // `bun run dev` often remaps Postgres off 5432 when busy.
  return "postgres://opengeni_app:opengeni_app@127.0.0.1:6432/opengeni";
}

async function mk(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    title: string;
    parentSessionId?: string | null;
    maxDepth?: number;
  },
): Promise<Session> {
  const session = await createSession(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    initialMessage: input.title,
    resources: [],
    metadata: { origin: ORIGIN, batch: BATCH, seedTitle: input.title },
    model: "scripted-model",
    sandboxBackend: "none",
    parentSessionId: input.parentSessionId ?? null,
    ...(input.maxDepth !== undefined
      ? {
          maxNestedAgentDepthOverride: input.maxDepth,
          allowNestedAgentDepthIncrease: true,
        }
      : {}),
    createdBy: { kind: "subject", subjectId: "dev", label: "Rail seed" },
  });
  await updateSessionTitle(db, {
    workspaceId: input.workspaceId,
    sessionId: session.id,
    title: input.title,
    source: "user",
  });
  return session;
}

async function paintStatuses(
  db: Database,
  accountId: string,
  workspaceId: string,
  byStatus: Partial<Record<Session["status"], string[]>>,
): Promise<void> {
  await withRlsContext(db, { accountId, workspaceId }, async (scoped) => {
    for (const [status, ids] of Object.entries(byStatus)) {
      if (!ids?.length) continue;
      await scoped
        .update(sessions)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(sessions.workspaceId, workspaceId), inArray(sessions.id, ids)));
    }
  });
}

async function main(): Promise<void> {
  const databaseUrl = resolveDatabaseUrl();
  const { workspaceId, accountId, subjectId } = await resolveIdentity();
  const { db, close } = createDb(databaseUrl);
  const created: Session[] = [];
  const push = (session: Session) => {
    created.push(session);
    return session;
  };

  console.log(
    `[seed:session-rail] workspace=${workspaceId} account=${accountId} subject=${subjectId}`,
  );
  console.log(`[seed:session-rail] db=${databaseUrl.replace(/:[^:@/]+@/, ":***@")} batch=${BATCH}`);

  try {
    // ── 1. Deep chain past the visual depth clamp (MAX_VISUAL_TREE_DEPTH=3) ──
    let deep = push(
      await mk(db, {
        accountId,
        workspaceId,
        title: "🌲 Deep root (chain past clamp)",
        maxDepth: 12,
      }),
    );
    for (let depth = 1; depth <= 7; depth += 1) {
      deep = push(
        await mk(db, {
          accountId,
          workspaceId,
          title: `Deep L${depth} — ${"🧬 ".repeat(depth)}nested`,
          parentSessionId: deep.id,
        }),
      );
    }

    // ── 2. Wide fan-out under one manager ───────────────────────────────────
    const wide = push(
      await mk(db, {
        accountId,
        workspaceId,
        title: "📂 Wide manager (many direct children)",
        maxDepth: 6,
      }),
    );
    const wideChildren: Session[] = [];
    for (let i = 1; i <= 22; i += 1) {
      wideChildren.push(
        push(
          await mk(db, {
            accountId,
            workspaceId,
            title: `Wide child ${String(i).padStart(2, "0")}`,
            parentSessionId: wide.id,
          }),
        ),
      );
    }
    // Grandchildren on a few wide children
    for (const parent of wideChildren.slice(0, 4)) {
      for (let j = 1; j <= 3; j += 1) {
        push(
          await mk(db, {
            accountId,
            workspaceId,
            title: `${parent.title} · g${j}`,
            parentSessionId: parent.id,
          }),
        );
      }
    }

    // ── 3. Balanced bushy tree ──────────────────────────────────────────────
    const bush = push(
      await mk(db, {
        accountId,
        workspaceId,
        title: "🌿 Bushy tree root",
        maxDepth: 8,
      }),
    );
    const bushL1: Session[] = [];
    for (let i = 1; i <= 3; i += 1) {
      bushL1.push(
        push(
          await mk(db, {
            accountId,
            workspaceId,
            title: `Bush branch ${i}`,
            parentSessionId: bush.id,
          }),
        ),
      );
    }
    for (const branch of bushL1) {
      for (let i = 1; i <= 3; i += 1) {
        const mid = push(
          await mk(db, {
            accountId,
            workspaceId,
            title: `${branch.title} / mid ${i}`,
            parentSessionId: branch.id,
          }),
        );
        for (let j = 1; j <= 2; j += 1) {
          push(
            await mk(db, {
              accountId,
              workspaceId,
              title: `Leaf ${i}.${j} under ${branch.title}`,
              parentSessionId: mid.id,
            }),
          );
        }
      }
    }

    // ── 4. Flat roots for scroll / search / title edge cases ────────────────
    const flatTitles = [
      "Idle planner",
      "Running deploy watch",
      "Needs approval — PR review",
      "Failed terraform apply",
      "Cancelled migration",
      "Queued backlog item",
      "Waiting for capacity · Codex",
      "Recovering after worker loss",
      "日本語タイトル — ネスト確認",
      "عنوان عربي مع نص طويل جداً جداً للتحقق من القص",
      "Emoji stress 🧭🛰️🧪 · truncate me please ".repeat(3),
      "Pinned later — ops runbook",
      "Pinned later — customer escalation",
      "Empty-looking short",
      "zzzz last alphabetically-ish",
    ];
    const flats: Session[] = [];
    for (const title of flatTitles) {
      flats.push(push(await mk(db, { accountId, workspaceId, title })));
    }
    // Pad flat roots until we hit the soft target
    let n = 1;
    while (created.length < TARGET) {
      flats.push(
        push(
          await mk(db, {
            accountId,
            workspaceId,
            title: `Scroll filler ${String(n).padStart(3, "0")}`,
          }),
        ),
      );
      n += 1;
    }

    // ── 5. Pins: roots + nested (tests nested-pin sections) ─────────────────
    const pinTargets = [
      deep, // deep root
      wideChildren[0]!, // nested pin under wide
      bush, // bush root
      flats[11]!, // "Pinned later — ops runbook"
      flats[12]!, // escalation
    ];
    for (const target of pinTargets) {
      await setSessionPin(db, {
        workspaceId,
        subjectId,
        sessionId: target.id,
        pinned: true,
      });
    }

    // ── 6. Status paint (status dots / labels in the rail) ──────────────────
    await paintStatuses(db, accountId, workspaceId, {
      idle: [flats[0]!.id, bush.id, wide.id],
      running: [flats[1]!.id, wideChildren[1]!.id],
      requires_action: [flats[2]!.id],
      failed: [flats[3]!.id],
      cancelled: [flats[4]!.id],
      queued: [flats[5]!.id, ...created.slice(-5).map((s) => s.id)],
      waiting_capacity: [flats[6]!.id],
      recovering: [flats[7]!.id],
    });
  } finally {
    await close();
  }

  const roots = created.filter((s) => !s.parentSessionId).length;
  const nested = created.length - roots;
  console.log(
    `[seed:session-rail] DONE created=${created.length} roots=${roots} nested=${nested} pinned=5 batch=${BATCH}`,
  );
  console.log(`[seed:session-rail] open: ${WEB_URL}/workspaces/${workspaceId}/sessions`);
  console.log(
    `[seed:session-rail] tip: expand Wide/Bush/Deep managers; nested pins should surface in Pinned.`,
  );
}

await main();
