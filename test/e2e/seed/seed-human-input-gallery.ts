// seed-human-input-gallery — freeze durable request_human_input scenarios for
// UI/UX review. Each scenario is one session left in requires_action with real
// pending human-input rows + session.humanInput.requested events (no LLM).
//
// Run (stack up). Prefer --env-file=/dev/null so a stale .env :5432 URL cannot
// override remapped compose ports:
//   set -a && . ./.env.runtime && set +a
//   bun --env-file=/dev/null test/e2e/seed/seed-human-input-gallery.ts
//
// Then screenshot:
//   bun --env-file=/dev/null test/e2e/seed/screenshot-human-input-gallery.ts
//
// Env (optional):
//   OPENGENI_DATABASE_URL / OPENGENI_SEED_BASE_URL / OPENGENI_SEED_WEB_URL
//   OPENGENI_SEED_WORKSPACE_ID / OPENGENI_SEED_ACCOUNT_ID / OPENGENI_SEED_SUBJECT_ID
import {
  applySessionTurnSettlement,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  submitHumanPromptInTransaction,
  updateSessionTitle,
  withWorkspaceSubjectRls,
  type Database,
} from "@opengeni/db";
import type { HumanInputQuestion } from "@opengeni/contracts";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BASE_URL, resolveWorkspaceId, WEB_URL } from "./harness";

const ORIGIN = "human-input-gallery-seed";
const BATCH = `human-input-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const SUBJECT = process.env.OPENGENI_SEED_SUBJECT_ID;
const OUT_DIR = join(import.meta.dir, "../../../tmp/human-input-ux-review");

type AccessMe = {
  subjectId?: string;
  defaultWorkspaceId?: string;
  workspaceGrants?: Array<{ workspaceId: string; accountId: string; subjectId: string }>;
};

type Scenario = {
  id: string;
  title: string;
  allowSkip: boolean;
  expiresInSeconds?: number | null;
  parallel?: boolean;
  questions: HumanInputQuestion[];
  parallelQuestions?: HumanInputQuestion[];
};

const SCENARIOS: Scenario[] = [
  {
    id: "text-basic",
    title: "HI · text required",
    allowSkip: false,
    questions: [
      {
        id: "name",
        kind: "text",
        prompt: "What should we call this environment?",
        options: [],
        required: true,
        allowOther: false,
      },
    ],
  },
  {
    id: "text-labeled-help",
    title: "HI · text label + help + optional",
    allowSkip: false,
    questions: [
      {
        id: "notes",
        kind: "text",
        prompt: "Add any deploy notes the on-call should see. Leave blank if nothing special.",
        label: "Deploy notes",
        helpText: "Shown in the change ticket. Markdown is fine.",
        options: [],
        required: false,
        allowOther: false,
      },
    ],
  },
  {
    id: "single-basic",
    title: "HI · single select",
    allowSkip: false,
    questions: [
      {
        id: "environment",
        kind: "single_select",
        prompt: "Which environment should we target?",
        options: [
          { id: "staging", label: "Staging" },
          { id: "production", label: "Production" },
        ],
        required: true,
        allowOther: false,
      },
    ],
  },
  {
    id: "single-desc-other",
    title: "HI · single + descriptions + Other",
    allowSkip: false,
    questions: [
      {
        id: "region",
        kind: "single_select",
        prompt: "Pick the primary region for this rollout.",
        label: "Primary region",
        helpText: "Affects latency and data residency.",
        options: [
          {
            id: "eu-west",
            label: "EU West",
            description: "Ireland. Default for GDPR-scoped customers.",
          },
          {
            id: "us-east",
            label: "US East",
            description: "Virginia. Lowest latency for US east-coast traffic.",
          },
          {
            id: "ap-southeast",
            label: "AP Southeast",
            description: "Singapore. Use only when APAC is the majority audience.",
          },
        ],
        required: true,
        allowOther: true,
      },
    ],
  },
  {
    id: "multi-basic",
    title: "HI · multi select",
    allowSkip: false,
    questions: [
      {
        id: "services",
        kind: "multi_select",
        prompt: "Which services should be included in the canary?",
        options: [
          { id: "api", label: "API" },
          { id: "worker", label: "Worker" },
          { id: "web", label: "Web" },
          { id: "relay", label: "Relay" },
        ],
        required: true,
        allowOther: false,
      },
    ],
  },
  {
    id: "multi-bounds-other",
    title: "HI · multi min/max + Other",
    allowSkip: false,
    questions: [
      {
        id: "owners",
        kind: "multi_select",
        prompt: "Who must approve the change window?",
        label: "Approvers",
        helpText: "Choose 2–3 teams (or Other).",
        options: [
          { id: "platform", label: "Platform" },
          { id: "security", label: "Security" },
          { id: "sre", label: "SRE" },
          { id: "product", label: "Product" },
          { id: "finance", label: "Finance" },
        ],
        required: true,
        allowOther: true,
        validation: { minSelections: 2, maxSelections: 3 },
      },
    ],
  },
  {
    id: "mixed-kitchen",
    title: "HI · mixed kitchen sink",
    allowSkip: false,
    questions: [
      {
        id: "env",
        kind: "single_select",
        prompt: "Target environment",
        options: [
          { id: "dev", label: "Dev" },
          { id: "staging", label: "Staging" },
          { id: "prod", label: "Production" },
        ],
        required: true,
        allowOther: false,
      },
      {
        id: "flags",
        kind: "multi_select",
        prompt: "Feature flags to flip",
        options: [
          { id: "new-composer", label: "New composer" },
          { id: "dense-rail", label: "Dense rail" },
          { id: "human-input-v2", label: "Human input v2" },
        ],
        required: false,
        allowOther: true,
        validation: { maxSelections: 2 },
      },
      {
        id: "summary",
        kind: "text",
        prompt: "One-line summary for the audit log",
        label: "Audit summary",
        helpText: "Required. Keep it short.",
        options: [],
        required: true,
        allowOther: false,
      },
    ],
  },
  {
    id: "allow-skip",
    title: "HI · allow Skip",
    allowSkip: true,
    questions: [
      {
        id: "optional-direction",
        kind: "single_select",
        prompt: "Want to steer the next step, or skip and let the agent decide?",
        options: [
          { id: "investigate", label: "Investigate first" },
          { id: "apply", label: "Apply the plan" },
          { id: "abort", label: "Abort the change" },
        ],
        required: true,
        allowOther: false,
      },
    ],
  },
  {
    id: "with-expiry",
    title: "HI · durable expiry",
    allowSkip: false,
    expiresInSeconds: 45 * 60,
    questions: [
      {
        id: "go-no-go",
        kind: "single_select",
        prompt: "Go / no-go for the maintenance window?",
        options: [
          { id: "go", label: "Go" },
          { id: "hold", label: "Hold" },
          { id: "cancel", label: "Cancel window" },
        ],
        required: true,
        allowOther: false,
      },
    ],
  },
  {
    id: "many-questions",
    title: "HI · many questions (scroll)",
    allowSkip: false,
    questions: Array.from({ length: 8 }, (_, index) => {
      const n = index + 1;
      if (n % 3 === 1) {
        return {
          id: `q${n}`,
          kind: "text" as const,
          prompt: `Freeform answer #${n}: anything the agent should remember?`,
          options: [],
          required: n !== 8,
          allowOther: false,
        };
      }
      if (n % 3 === 2) {
        return {
          id: `q${n}`,
          kind: "single_select" as const,
          prompt: `Single choice #${n}`,
          options: [
            { id: `a${n}`, label: `Option A${n}` },
            { id: `b${n}`, label: `Option B${n}` },
            { id: `c${n}`, label: `Option C${n}` },
          ],
          required: true,
          allowOther: n === 5,
        };
      }
      return {
        id: `q${n}`,
        kind: "multi_select" as const,
        prompt: `Multi choice #${n}`,
        options: [
          { id: `x${n}`, label: `X${n}` },
          { id: `y${n}`, label: `Y${n}` },
          { id: `z${n}`, label: `Z${n}` },
        ],
        required: true,
        allowOther: false,
        validation: { minSelections: 1, maxSelections: 2 },
      };
    }),
  },
  {
    id: "many-options",
    title: "HI · many options (20)",
    allowSkip: false,
    questions: [
      {
        id: "cluster",
        kind: "single_select",
        prompt: "Which cluster should receive the workload?",
        label: "Cluster",
        helpText: "Hard cap is 20 options in the tool contract.",
        options: Array.from({ length: 20 }, (_, index) => ({
          id: `c${index + 1}`,
          label: `cluster-${String(index + 1).padStart(2, "0")}`,
          description:
            index % 4 === 0
              ? "Busy shared pool — prefer only if dedicated capacity is unavailable."
              : null,
        })),
        required: true,
        allowOther: false,
      },
    ],
  },
  {
    id: "long-copy",
    title: "HI · long wrapping copy",
    allowSkip: true,
    questions: [
      {
        id: "policy",
        kind: "single_select",
        prompt:
          "The agent found a policy conflict between the workspace pack image pin, the session-level sandbox backend override, and the Connected Machine route that was seeded at create time. How should it resolve the conflict before mutating /workspace?",
        label: "Resolve compute conflict",
        helpText:
          "This prompt is intentionally long to stress wrapping above the composer, especially on narrow viewports where the form already competes with SessionChrome and the composer.",
        options: [
          {
            id: "keep-machine",
            label:
              "Keep the Connected Machine route and ignore the degraded cloud archive entirely",
            description:
              "Machine-primary: do not acquire or mutate the managed-home lease; use sessions.working_dir.",
          },
          {
            id: "fall-back-box",
            label:
              "Fall back to the managed sandbox box even though the machine was explicitly selected",
            description:
              "Usually wrong for an explicit machine target — included to see how a long selected option reads.",
          },
          {
            id: "ask-again",
            label: "Stop and ask a human with a shorter clarifying question",
          },
        ],
        required: true,
        allowOther: true,
      },
    ],
  },
  {
    id: "parallel-two",
    title: "HI · parallel requests stacked",
    allowSkip: false,
    parallel: true,
    questions: [
      {
        id: "env",
        kind: "single_select",
        prompt: "Environment for request A",
        options: [
          { id: "staging", label: "Staging" },
          { id: "production", label: "Production" },
        ],
        required: true,
        allowOther: false,
      },
    ],
    parallelQuestions: [
      {
        id: "window",
        kind: "text",
        prompt: "Preferred change window (request B)",
        label: "Change window",
        helpText: "Second pending request — forms stack in one scroll region.",
        options: [],
        required: true,
        allowOther: false,
      },
    ],
  },
];

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
  return "postgres://opengeni_app:opengeni_app@127.0.0.1:5432/opengeni";
}

async function sendAndClaim(
  db: Database,
  identity: { workspaceId: string; accountId: string; subjectId: string },
  sessionId: string,
): Promise<{ turnId: string; attemptId: string; triggerEventId: string }> {
  // createSession(scripted-model) can leave a queued shell with no turn; the
  // unit-test fixture path is send → claim before the live worker wins.
  await withWorkspaceSubjectRls(db, identity.workspaceId, identity.subjectId, (scoped) =>
    scoped.transaction((tx) =>
      submitHumanPromptInTransaction(tx as typeof scoped, {
        accountId: identity.accountId,
        workspaceId: identity.workspaceId,
        sessionId,
        subjectId: identity.subjectId,
        actor: { type: "human", subjectId: identity.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "continue with my decision",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
    ),
  );

  for (let i = 0; i < 40; i += 1) {
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(db, identity.workspaceId, {
      sessionId,
      workflowId: `session-${sessionId}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    if (claim.action === "claimed") {
      return {
        turnId: claim.turn.id,
        attemptId,
        triggerEventId: claim.turn.triggerEventId,
      };
    }
    await Bun.sleep(25 + i * 15);
  }
  throw new Error(`could not claim session ${sessionId} for human-input freeze`);
}

async function freezeScenario(
  db: Database,
  identity: { workspaceId: string; accountId: string; subjectId: string },
  scenario: Scenario,
): Promise<{ sessionId: string; url: string }> {
  const session = await createSession(db, {
    accountId: identity.accountId,
    workspaceId: identity.workspaceId,
    initialMessage: `Human-input gallery: ${scenario.title}`,
    resources: [],
    metadata: {
      origin: ORIGIN,
      batch: BATCH,
      scenarioId: scenario.id,
      seedTitle: scenario.title,
    },
    model: "scripted-model",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: identity.subjectId, label: "Human input gallery" },
  });
  await updateSessionTitle(db, {
    workspaceId: identity.workspaceId,
    sessionId: session.id,
    title: scenario.title,
    source: "user",
  });

  const claimed = await sendAndClaim(db, identity, session.id);
  const expiresAt =
    scenario.expiresInSeconds != null
      ? new Date(Date.now() + scenario.expiresInSeconds * 1000)
      : null;
  const requestId = crypto.randomUUID();
  const parallelRequestId = scenario.parallel ? crypto.randomUUID() : null;
  const humanInputRequests = [
    {
      id: requestId,
      toolCallId: `human-call-${scenario.id}-a`,
      questions: scenario.questions,
      allowSkip: scenario.allowSkip,
      expiresAt,
    },
    ...(parallelRequestId && scenario.parallelQuestions
      ? [
          {
            id: parallelRequestId,
            toolCallId: `human-call-${scenario.id}-b`,
            questions: scenario.parallelQuestions,
            allowSkip: false,
            expiresAt,
          },
        ]
      : []),
  ];

  const settlement = await applySessionTurnSettlement(db, identity.workspaceId, {
    sessionId: session.id,
    turnId: claimed.turnId,
    triggerEventId: claimed.triggerEventId,
    attemptId: claimed.attemptId,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: claimed.turnId,
    runState: {
      serializedRunState: JSON.stringify({
        version: 1,
        interrupted: true,
        gallery: scenario.id,
      }),
      pendingApprovals: [],
      humanInputRequests,
    },
    events: [
      {
        type: "agent.message.completed",
        payload: {
          text: `I need a decision before continuing (${scenario.id}).`,
        },
      },
      ...humanInputRequests.map((request) => ({
        type: "session.humanInput.requested" as const,
        payload: { request },
      })),
      { type: "session.status.changed", payload: { status: "requires_action" } },
    ],
  });
  if (settlement.action !== "settled") {
    throw new Error(`settlement stale for ${scenario.id}: ${JSON.stringify(settlement)}`);
  }

  return {
    sessionId: session.id,
    url: `${WEB_URL}/workspaces/${identity.workspaceId}/sessions/${session.id}`,
  };
}

async function main(): Promise<void> {
  const databaseUrl = resolveDatabaseUrl();
  const identity = await resolveIdentity();
  const { db, close } = createDb(databaseUrl);
  mkdirSync(OUT_DIR, { recursive: true });

  console.log(
    `[seed:human-input] workspace=${identity.workspaceId} account=${identity.accountId} subject=${identity.subjectId}`,
  );
  console.log(`[seed:human-input] db=${databaseUrl.replace(/:[^:@/]+@/, ":***@")} batch=${BATCH}`);
  console.log(`[seed:human-input] web=${WEB_URL} api=${BASE_URL}`);

  const results: Array<{
    id: string;
    title: string;
    sessionId: string;
    url: string;
  }> = [];

  try {
    for (const scenario of SCENARIOS) {
      const frozen = await freezeScenario(db, identity, scenario);
      results.push({
        id: scenario.id,
        title: scenario.title,
        sessionId: frozen.sessionId,
        url: frozen.url,
      });
      console.log(`[seed:human-input] ${scenario.id} → ${frozen.url}`);
    }
  } finally {
    await close();
  }

  const manifest = {
    batch: BATCH,
    createdAt: new Date().toISOString(),
    workspaceId: identity.workspaceId,
    webUrl: WEB_URL,
    apiUrl: BASE_URL,
    scenarios: results,
  };
  const manifestPath = join(OUT_DIR, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[seed:human-input] wrote ${manifestPath} (${results.length} scenarios)`);
}

await main();
