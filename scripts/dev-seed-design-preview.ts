#!/usr/bin/env bun
/**
 * Seed a LOCAL managed-mode dev stack with fake data for UI design previews.
 *
 *   bun scripts/dev-seed-design-preview.ts --yes [--credentials <file>]
 *
 * Safety:
 * - Runs only against this worktree's own `bun run dev` stack: the API URL comes
 *   from `.env.runtime` (OPENGENI_API_PORT), must be loopback, and the API must
 *   report `productAccessMode: managed`. `--api` may only name that same URL.
 * - Requires an explicit `--yes`.
 * - Uses the public API and Better Auth endpoints. Direct SQL (through the
 *   worktree's loopback migrations DSN) is used only where no API exists:
 *   expired API keys; finished conversation history (real-shaped tool calls,
 *   approvals, questions, sub-agents, goals; see dev-seed-design-preview/);
 *   file publications; schedule run history; Knowledge proposals awaiting
 *   review; and Insights usage facts.
 * - Never sends a model turn: session shells are created empty in realtime
 *   start mode and the SQL history creates no workflow wakes or outbox rows.
 *   Sessions left waiting on a person get a closed requires_action attempt,
 *   the state a real worker leaves behind. Schedules are paused, `manual`
 *   (fires only on Run now), or active in the database only while their
 *   Temporal schedule stays paused. Sending a message, answering, approving,
 *   Run now, or editing/resuming a schedule would start real turns.
 *
 * Idempotent: every object is looked up by name first and reused.
 *
 * Passwords: the owner (bendik@acme.dev) password is read from, or generated
 * into, the credentials file (mode 0600). Other fake people share a derived
 * password (generated) stored in the same file.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";
import { buildSeedFiles, type SeedFile } from "./dev-seed-design-preview/files";
import {
  PERSONAL_RICH_SESSIONS,
  SHARED_RICH_SESSIONS,
  type ArtifactRef,
  type RichSessionSeed,
} from "./dev-seed-design-preview/rich-sessions";
import { COST_REVIEW_HTML, FLEET_SITE_HTML, ONCALL_HTML } from "./dev-seed-design-preview/sites";
import {
  CAPABILITIES,
  DISPLAY_ACTIVE_SCHEDULES,
  EXTRA_SCHEDULES,
  EXTRA_VARIABLE_SETS,
  INTEGRATIONS,
  PENDING_KNOWLEDGE,
  PERSONAL_KNOWLEDGE,
  RIGS,
  SCHEDULE_RUNS,
  SESSION_VARIABLE_SETS,
  USAGE_MODELS,
  scheduledRunSessions,
  type ScheduleSeed,
} from "./dev-seed-design-preview/surfaces";
import { LIVE_CONTENT, applyLiveBatch } from "./dev-seed-design-preview/live-edit";
import { ConversationBuilder, type SeedEventRow } from "./dev-seed-design-preview/timeline";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function fail(message: string): never {
  console.error(`dev-seed-design-preview: ${message}`);
  process.exit(1);
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]!] = match[2]!.replace(/^['"]|['"]$/g, "");
  }
  return values;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

// ---------------------------------------------------------------------------
// Safety gate
// ---------------------------------------------------------------------------
if (!flag("--yes")) {
  fail("refusing to run without --yes (this writes fake data into the local dev stack).");
}
const runtime = readEnvFile(resolve(repositoryRoot, ".env.runtime"));
if (!runtime.OPENGENI_API_PORT) {
  fail("no .env.runtime with OPENGENI_API_PORT; start this worktree's stack with `bun run dev`.");
}
const stackApi = `http://127.0.0.1:${runtime.OPENGENI_API_PORT}`;
const API = (option("--api") ?? stackApi).replace(/\/$/, "");
{
  const url = new URL(API);
  if (!LOOPBACK.has(url.hostname)) fail(`API ${API} is not loopback.`);
  if (url.port !== runtime.OPENGENI_API_PORT) {
    fail(`API ${API} is not this worktree's dev stack (port ${runtime.OPENGENI_API_PORT}).`);
  }
}
const migrationsUrl = runtime.OPENGENI_MIGRATIONS_DATABASE_URL;
if (migrationsUrl && !LOOPBACK.has(new URL(migrationsUrl).hostname)) {
  fail("the worktree database URL is not loopback.");
}

const clientConfig = (await (await fetch(`${API}/v1/config/client`)).json()) as {
  apiContractRevision: string;
  productAccessMode: string;
};
if (clientConfig.productAccessMode !== "managed") {
  fail(`API product access mode is ${clientConfig.productAccessMode}; expected managed.`);
}
const CONTRACT = clientConfig.apiContractRevision;
// Browser origin the web dev server serves; Better Auth checks it on cookie requests.
const ORIGIN =
  readEnvFile(resolve(repositoryRoot, ".env")).OPENGENI_PUBLIC_BASE_URL ?? "http://127.0.0.1:3000";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
const credentialsPath =
  option("--credentials") ?? resolve(homedir(), ".config/opengeni-design-preview/credentials");
const credentials = readEnvFile(credentialsPath);
if (!credentials.OWNER_PASSWORD || !credentials.PEOPLE_PASSWORD) {
  credentials.OWNER_EMAIL = "bendik@acme.dev";
  credentials.OWNER_PASSWORD ||= randomBytes(18).toString("base64url");
  credentials.PEOPLE_PASSWORD ||= randomBytes(18).toString("base64url");
  mkdirSync(dirname(credentialsPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    credentialsPath,
    [
      "# OpenGeni design-preview stack (local fake data only).",
      `# Sign in at ${ORIGIN}`,
      `URL=${ORIGIN}`,
      `OWNER_EMAIL=${credentials.OWNER_EMAIL}`,
      `OWNER_PASSWORD=${credentials.OWNER_PASSWORD}`,
      "# Every other seeded @acme.dev person uses this password.",
      `PEOPLE_PASSWORD=${credentials.PEOPLE_PASSWORD}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  chmodSync(credentialsPath, 0o600);
  console.log(`Wrote credentials to ${credentialsPath}`);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
class Client {
  cookie: string | null = null;
  constructor(readonly label: string) {}

  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    options: { allow?: number[] } = {},
  ): Promise<{ status: number; body: T; headers: Headers }> {
    const headers: Record<string, string> = { origin: ORIGIN };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["x-opengeni-api-contract"] = CONTRACT;
    if (this.cookie) headers.cookie = this.cookie;
    const response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const value of setCookie) {
      const pair = value.split(";")[0]!;
      if (pair.startsWith("better-auth.session_token=")) this.cookie = pair;
    }
    const text = await response.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }
    if (!response.ok && !(options.allow ?? []).includes(response.status)) {
      throw new Error(
        `[${this.label}] ${method} ${path} -> ${response.status}: ${text.slice(0, 600)}`,
      );
    }
    return {
      status: response.status,
      body: parsed as T,
      headers: response.headers,
    };
  }
  get<T = any>(path: string) {
    return this.request<T>("GET", path).then((r) => r.body);
  }
  post<T = any>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body ?? {}).then((r) => r.body);
  }
  put<T = any>(path: string, body: unknown) {
    return this.request<T>("PUT", path, body).then((r) => r.body);
  }
  patch<T = any>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, body).then((r) => r.body);
  }
  del(path: string) {
    return this.request("DELETE", path, undefined, { allow: [404] });
  }
}

async function signIn(name: string, email: string, password: string): Promise<Client> {
  const client = new Client(name);
  const signInResult = await client.request(
    "POST",
    "/v1/auth/sign-in/email",
    { email, password },
    { allow: [401, 403] },
  );
  if (signInResult.status === 200 && client.cookie) return client;
  await client.request("POST", "/v1/auth/sign-up/email", {
    name,
    email,
    password,
  });
  if (!client.cookie) {
    await client.request("POST", "/v1/auth/sign-in/email", { email, password });
  }
  if (!client.cookie) fail(`could not obtain a session for ${email}`);
  console.log(`  signed up ${name} <${email}>`);
  return client;
}

// Email sign-in is throttled per email and source (10 per 15 minutes), and the
// web dev server proxies the owner's browser from the same loopback source, so
// reruns reuse a cached owner session instead of signing in again.
const sessionCachePath = resolve(dirname(credentialsPath), "owner-session");
async function ownerClient(): Promise<Client> {
  if (existsSync(sessionCachePath)) {
    const cached = new Client(OWNER.name);
    cached.cookie = readFileSync(sessionCachePath, "utf8").trim();
    const session = await cached.request("GET", "/v1/auth/get-session", undefined, {
      allow: [401, 403],
    });
    if (session.status === 200 && session.body?.user?.email === OWNER.email) return cached;
  }
  const client = await signIn(OWNER.name, OWNER.email, credentials.OWNER_PASSWORD!);
  writeFileSync(sessionCachePath, `${client.cookie}\n`, { mode: 0o600 });
  return client;
}

const log = (message: string) => console.log(message);

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
const ORG_NAME = "Acme Robotics";
const OWNER = { name: "Bendik Hansen", email: "bendik@acme.dev" };
type Person = {
  key: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  state: "active" | "pending" | "suspended";
};
const PEOPLE: Person[] = [
  {
    key: "maria",
    name: "Maria Chen",
    email: "maria@acme.dev",
    role: "admin",
    state: "active",
  },
  {
    key: "jonas",
    name: "Jonas Berg",
    email: "jonas@acme.dev",
    role: "member",
    state: "active",
  },
  {
    key: "aiko",
    name: "Aiko Tanaka",
    email: "aiko@acme.dev",
    role: "member",
    state: "active",
  },
  {
    key: "tom",
    name: "Tom Eriksen",
    email: "tom@acme.dev",
    role: "member",
    state: "suspended",
  },
  {
    key: "priya",
    name: "Priya Nair",
    email: "priya@acme.dev",
    role: "member",
    state: "pending",
  },
];

type Grant = "viewer" | "member" | "admin";
type WorkspaceSeed = {
  name: string;
  grants: Record<string, Grant>;
  variableSets: {
    name: string;
    description: string;
    vars: Record<string, string>;
    updates?: Record<string, string[]>;
  }[];
  schedules: {
    name: string;
    prompt: string;
    schedule: Record<string, unknown>;
    overlapPolicy?: string;
    variableSet?: string;
  }[];
  apiKeys: {
    name: string;
    description: string;
    permissions: string[];
    expires?: "future" | "expired";
    revoked?: boolean;
  }[];
  instructions: string[];
  knowledge: {
    group: string;
    /** A parent collection seeded earlier in this list: collections nest. */
    parent?: string;
    entries: { title: string; kind: string; content: string }[];
  }[];
  sessions: SessionSeed[];
};

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

// Finished conversations. `hoursAgo` is the last activity; `unread` leaves the
// owner's read marker behind the final answer. Children render nested under
// their parent in the rail.
type Exchange = [user: string, assistant: string];
type SessionSeed = {
  title: string;
  hoursAgo: number;
  unread?: boolean;
  exchanges: Exchange[];
  children?: { title: string; exchanges: Exchange[] }[];
};

const CONVERSATIONS: Record<string, SessionSeed[]> = {
  "Platform engineering": [
    {
      title: "Investigate flaky integration tests",
      hoursAgo: 0.3,
      unread: true,
      exchanges: [
        [
          "The checkout integration tests fail about one run in five on CI. Can you find out why?",
          "I compared the last 40 CI runs. All failures come from `checkout.spec.ts` and every one times out waiting for the payment mock.\n\nThe mock server starts in parallel with the tests, so on slow runners the first request arrives before it is listening.\n\n**Suggested fix:** wait for the mock's `/healthz` before starting the suite. I can open a pull request for that.",
        ],
        [
          "Yes, open the pull request.",
          "Done. The pull request adds a readiness wait (max 30 s) to the test setup and removes the old `sleep 2`. 25 consecutive CI runs passed on the branch.",
        ],
      ],
      children: [
        {
          title: "Collect CI failure logs",
          exchanges: [
            [
              "Download the logs for the last 40 checkout test runs and group failures by error.",
              "40 runs checked, 8 failures. All 8 are `ECONNREFUSED 127.0.0.1:4010` in the first test of `checkout.spec.ts`.",
            ],
          ],
        },
        {
          title: "Draft readiness check PR",
          exchanges: [
            [
              "Write the readiness wait for the payment mock and open a draft pull request.",
              "Draft pull request opened with a `waitForHealthy()` helper and updated test setup.",
            ],
          ],
        },
      ],
    },
    {
      title: "Plan Postgres 17 upgrade",
      hoursAgo: 5,
      exchanges: [
        [
          "We need to move the main database from Postgres 15 to 17. Outline a plan with minimal downtime.",
          "Here is a plan with an expected write pause under 2 minutes:\n\n1. Create a Postgres 17 replica with logical replication.\n2. Run the test suite and a read-only canary against it for a week.\n3. Check extensions: `pg_stat_statements` and `pgvector` both support 17.\n4. During a quiet window, pause writes, wait for replication lag to reach zero, and switch the connection string.\n5. Keep the old primary for 48 hours as a rollback path.",
        ],
        [
          "What could go wrong?",
          "The main risks are sequences (logical replication does not copy them, so sync them before the switch), large objects, and any query that relies on the old planner behaviour. I would also re-run `ANALYZE` right after the switch.",
        ],
      ],
    },
    {
      title: "Review Terraform drift in eu-north-1",
      hoursAgo: 26,
      exchanges: [
        [
          "Check for Terraform drift in the eu-north-1 stack.",
          "`terraform plan` shows 3 drifted resources:\n\n- A security group rule added by hand (port 8443 open to the office range).\n- An S3 bucket lifecycle rule changed from 30 to 90 days.\n- A tag missing on two EC2 instances.\n\nNothing is destructive. I did not apply anything; tell me which changes to keep.",
        ],
      ],
    },
    {
      title: "Rotate staging database password",
      hoursAgo: 50,
      exchanges: [
        [
          "Rotate the staging database password and update the variable set.",
          "The password was rotated and the Staging database variable set now holds the new value. The old password stops working in 24 hours.",
        ],
      ],
    },
    {
      title: "Why did the nightly backup job take 3 hours?",
      hoursAgo: 75,
      unread: true,
      exchanges: [
        [
          "The nightly backup took 3 hours instead of 40 minutes. Why?",
          "The backup volume grew by 60% on Tuesday because the analytics events table was not pruned. The prune job failed silently after a permission change. Re-granting `DELETE` to the job role fixes it; the next backup should be back to normal.",
        ],
      ],
    },
    {
      title: "Summarize last week's incidents",
      hoursAgo: 150,
      exchanges: [
        [
          "Summarize last week's incidents for the Monday meeting.",
          "Two incidents last week:\n\n| Date | Impact | Cause |\n| --- | --- | --- |\n| Tue | Checkout slow for 20 min | Cache node restarted |\n| Thu | Webhook delays for 1 h | Queue consumer stuck |\n\nBoth have follow-up tickets. No customer data was affected.",
        ],
      ],
    },
  ],
  "Customer success": [
    {
      title: "Draft reply for delayed shipment",
      hoursAgo: 1.5,
      unread: true,
      exchanges: [
        [
          "A customer asks why their robot kit is two weeks late. Draft a friendly reply.",
          "Hi Sam,\n\nThanks for your patience, and sorry your kit is late. A component shortage delayed this batch; your order ships this Friday and you will get tracking the same day.\n\nAs a thank you, we have added a free spare battery to your order.\n\nBest regards,\nAcme Robotics Support",
        ],
      ],
    },
    {
      title: "Summarize feedback from Q3 survey",
      hoursAgo: 30,
      exchanges: [
        [
          "Summarize the open-text answers from the Q3 customer survey.",
          "212 answers. The top themes:\n\n1. **Setup guide** (41 mentions): step 4 is confusing.\n2. **Battery life** (33): shorter than expected in cold rooms.\n3. **App pairing** (27): Bluetooth pairing fails on some Android phones.\n\nOverall sentiment is positive (72%).",
        ],
        [
          "Which of these should we fix first?",
          "The setup guide: it is the most mentioned, cheapest to fix, and the survey shows people who struggled with setup rate us 1.4 points lower.",
        ],
      ],
      children: [
        {
          title: "Tag survey answers by theme",
          exchanges: [
            [
              "Tag each survey answer with one theme.",
              "All 212 answers tagged. 18 did not fit any theme and are marked 'other'.",
            ],
          ],
        },
      ],
    },
    {
      title: "Find customers affected by the pairing bug",
      hoursAgo: 60,
      exchanges: [
        [
          "Which customers reported the Android pairing bug this month?",
          "14 tickets from 12 customers mention pairing failures on Android 14. I listed them in a table with ticket links and phone models; 9 of them use the same phone brand.",
        ],
      ],
    },
    {
      title: "Update refund macro",
      hoursAgo: 200,
      exchanges: [
        [
          "Update the refund macro to mention the 30-day window.",
          "The macro now says refunds are available within 30 days of purchase and links to the refund policy article.",
        ],
      ],
    },
  ],
  "Finance ops": [
    {
      title: "Reconcile September card transactions",
      hoursAgo: 3,
      unread: true,
      exchanges: [
        [
          "Reconcile September card transactions against receipts.",
          "312 transactions checked. 298 match a receipt. 14 are missing receipts, totalling 18 420 NOK; I listed them by cardholder so you can send reminders.",
        ],
      ],
    },
    {
      title: "Explain the travel cost increase",
      hoursAgo: 48,
      exchanges: [
        [
          "Travel costs are up 35% this quarter. Why?",
          "Most of the increase (80%) comes from the robotics trade fair in Hamburg: flights and hotels for 9 people. Without it, travel costs are up 6%.",
        ],
      ],
    },
    {
      title: "Prepare VAT report draft",
      hoursAgo: 120,
      exchanges: [
        [
          "Prepare a draft of the VAT report for the last period.",
          "Draft ready. Output VAT 412 300 NOK, input VAT 188 950 NOK, payable 223 350 NOK. Two invoices have unusual VAT codes; please review them before submitting.",
        ],
      ],
    },
  ],
  "Design preview": [
    {
      title: "Audit settings page spacing",
      hoursAgo: 0.8,
      unread: true,
      exchanges: [
        [
          "Check the settings pages for inconsistent spacing.",
          "I found 11 places that do not follow the 4px scale:\n\n- Section headers use 18px instead of 16px below them (6 pages).\n- API key rows have 14px vertical padding instead of 12px.\n- The danger zone uses 40px top margin instead of 48px.\n\nScreenshots are attached to each finding.",
        ],
        [
          "Fix the section headers first.",
          "Done: section headers now use the shared `Section` component, so all six pages get 16px automatically.",
        ],
      ],
      children: [
        {
          title: "Measure spacing on API keys page",
          exchanges: [
            [
              "Measure the spacing on the API keys page.",
              "Row padding is 14px top and bottom; the design says 12px. Everything else matches.",
            ],
          ],
        },
      ],
    },
    {
      title: "Compare dark mode palettes",
      hoursAgo: 8,
      exchanges: [
        [
          "Compare our dark mode palette with the light one for contrast issues.",
          "Two tokens fail WCAG AA in dark mode: `text-muted` on `surface-raised` (3.9:1) and the link colour on the selected row (4.1:1). Raising `text-muted` lightness by 6% fixes both.",
        ],
      ],
    },
    {
      title: "Write empty state copy",
      hoursAgo: 28,
      exchanges: [
        [
          "Write empty state copy for Schedules, Variable sets and API keys.",
          "**Schedules:** Nothing scheduled yet. Schedules run agent work on a timer.\n\n**Variable sets:** No variable sets. Store credentials once and use them in any session.\n\n**API keys:** No API keys. Create one to start work from your own tools.",
        ],
      ],
    },
    {
      title: "Review onboarding flow",
      hoursAgo: 72,
      unread: true,
      exchanges: [
        [
          "Walk through the onboarding flow and list friction points.",
          "Five friction points, in order of impact:\n\n1. The workspace name step comes before the user knows what a workspace is.\n2. 'Connect a model' has no explanation of cost.\n3. The invite step can't be skipped on mobile.\n4. Two different words are used for the same thing: 'Organization' and 'Company'.\n5. The final screen has no clear next action.",
        ],
      ],
      children: [
        {
          title: "Record onboarding screenshots",
          exchanges: [
            [
              "Capture each onboarding step at desktop and phone width.",
              "14 screenshots captured, 7 steps at two widths.",
            ],
          ],
        },
      ],
    },
    {
      title: "Icon audit for the rail",
      hoursAgo: 170,
      exchanges: [
        [
          "Are the rail icons consistent?",
          "All rail icons use the same 16px line set except Capabilities, which uses a filled icon. Replacing it with the line version makes the set consistent.",
        ],
      ],
    },
    {
      title: "Button label review",
      hoursAgo: 340,
      exchanges: [
        [
          "Find button labels that are not sentence case.",
          "7 labels use title case, for example 'Create API Key' and 'Add New Schedule'. I listed the files and suggested replacements.",
        ],
      ],
    },
  ],
};

const WORKSPACES: WorkspaceSeed[] = [
  {
    name: "Platform engineering",
    grants: { maria: "admin", jonas: "member", aiko: "viewer", tom: "member" },
    variableSets: [
      {
        name: "AWS production",
        description: "Read-only role for cost and inventory checks.",
        vars: {
          AWS_ACCESS_KEY_ID: "AKIAFAKEEXAMPLE00001",
          AWS_SECRET_ACCESS_KEY: "fake-secret-not-real-0001",
          AWS_REGION: "eu-north-1",
          AWS_ACCOUNT_ID: "000000000001",
        },
        updates: {
          AWS_ACCESS_KEY_ID: ["AKIAFAKEEXAMPLE00002", "AKIAFAKEEXAMPLE00003"],
          AWS_SECRET_ACCESS_KEY: ["fake-secret-not-real-0002"],
        },
      },
      {
        name: "GitHub automation",
        description: "Bot token for dependency update pull requests.",
        vars: {
          GITHUB_BOT_TOKEN: "ghp_fakefakefakefakefake0001",
          GITHUB_ORG: "acme-robotics",
        },
        updates: { GITHUB_BOT_TOKEN: ["ghp_fakefakefakefakefake0002"] },
      },
      {
        name: "Datadog",
        description: "Monitoring API access.",
        vars: {
          DD_API_KEY: "fake-dd-api-key",
          DD_APP_KEY: "fake-dd-app-key",
          DD_SITE: "datadoghq.eu",
        },
      },
      {
        name: "Staging database",
        description: "Staging Postgres for migration dry runs.",
        vars: {
          DATABASE_URL: "postgres://app:fake@staging-db.acme.dev:5432/app",
          PGSSLMODE: "require",
          PGUSER: "app",
        },
        updates: { PGSSLMODE: ["verify-full"] },
      },
    ],
    schedules: [
      {
        name: "Summarize new Sentry errors",
        prompt: "Summarize new Sentry errors since the last run and group them by service.",
        schedule: { type: "interval", everySeconds: 3600 },
        overlapPolicy: "skip",
      },
      {
        name: "Check AWS cost anomalies",
        prompt:
          "Compare yesterday's AWS spend with the 14-day average and flag services above 20%.",
        schedule: {
          type: "calendar",
          timeZone: "Europe/Oslo",
          hour: 8,
          minute: 0,
        },
        variableSet: "AWS production",
      },
      {
        name: "Weekly dependency update PR",
        prompt: "Open one pull request that bumps patch-level dependencies in the main services.",
        schedule: {
          type: "calendar",
          timeZone: "Europe/Oslo",
          hour: 9,
          minute: 30,
          daysOfWeek: ["MONDAY"],
        },
        overlapPolicy: "buffer_one",
        variableSet: "GitHub automation",
      },
      {
        name: "Monthly access review",
        prompt: "List users and API keys with production access and highlight inactive ones.",
        schedule: { type: "interval", everySeconds: 2_592_000 },
        variableSet: "Datadog",
      },
    ],
    apiKeys: [
      {
        name: "CI pipeline",
        description: "Starts review sessions from CI.",
        permissions: ["workspace:read", "sessions:create", "sessions:read"],
      },
      {
        name: "Terraform runner",
        description: "Reads variable sets during plan.",
        permissions: ["workspace:read", "variable-sets:list", "variable-sets:read"],
        expires: "future",
      },
      {
        name: "Old deploy hook",
        description: "Replaced by the CI pipeline key.",
        permissions: ["workspace:read", "sessions:create"],
        expires: "expired",
      },
      {
        name: "Leaked test key",
        description: "Revoked after it was pasted in a ticket.",
        permissions: ["workspace:read"],
        revoked: true,
      },
    ],
    instructions: [
      "Prefer small, reviewable pull requests. Always run the unit tests before proposing a change.",
      "Prefer small, reviewable pull requests. Always run the unit tests before proposing a change.\n\nNever apply Terraform changes; produce a plan and ask for approval.",
      "Prefer small, reviewable pull requests (under 400 lines). Always run the unit tests before proposing a change.\n\nNever apply Terraform changes; produce a plan and ask for approval.\n\nTag the owning team from CODEOWNERS on every pull request.",
    ],
    knowledge: [
      {
        group: "Runbooks",
        entries: [
          {
            title: "Rolling back a bad deploy",
            kind: "note",
            content:
              "Use the deploy dashboard to pick the previous release, then run the rollback job. Confirm error rates return to baseline within 10 minutes.",
          },
          {
            title: "Database failover",
            kind: "note",
            content:
              "Promote the replica in the secondary region, update the DNS alias, then page the on-call database owner.",
          },
        ],
      },
      {
        group: "Payments",
        parent: "Runbooks",
        entries: [
          {
            title: "Card processor is returning errors",
            kind: "incident",
            content:
              "When the processor error rate passes 2%, switch checkout to the backup processor from the payments dashboard and post in #payments-oncall.",
          },
          {
            title: "Retry failed payouts",
            kind: "note",
            content:
              "Failed payouts are retried automatically for 3 days. After that, re-queue them from the payouts admin page with the original idempotency key.",
          },
          {
            title: "Never replay a charge by hand",
            kind: "requirement",
            content:
              "Charges are only retried through the payments service, which reuses the idempotency key. Replaying a request by hand can charge the customer twice.",
          },
          {
            title: "Payment webhooks are processed in order per account",
            kind: "decision",
            content:
              "We queue processor webhooks per merchant account so a refund can never be applied before its charge.",
          },
        ],
      },
      {
        group: "Refunds",
        parent: "Payments",
        entries: [
          {
            title: "Issue a partial refund",
            kind: "note",
            content:
              "Open the charge in the payments admin, choose Refund, enter the amount and a reason. The customer sees it in 5-10 business days.",
          },
          {
            title: "Refunds over $5,000 need a second approver",
            kind: "requirement",
            content: "Finance must approve any single refund above $5,000 before it is issued.",
          },
          {
            title: "Refund window is 90 days",
            kind: "fact",
            content:
              "The card processor rejects refunds on charges older than 90 days; use a bank transfer instead.",
          },
        ],
      },
      {
        group: "Deploys",
        parent: "Runbooks",
        entries: [
          {
            title: "Deploy freeze on Fridays after 14:00",
            kind: "decision",
            content:
              "No production deploys after 14:00 on Fridays unless it fixes an active incident.",
          },
          {
            title: "Canary before full rollout",
            kind: "requirement",
            content:
              "Every production deploy runs on the canary pool for 15 minutes with error rates at baseline before it rolls out everywhere.",
          },
          {
            title: "Deploy pipeline takes about 12 minutes",
            kind: "fact",
            content:
              "Build 4 minutes, tests 5 minutes, canary and rollout 3 minutes on a normal day.",
          },
          {
            title: "Stuck deploy lock",
            kind: "incident",
            content:
              "A cancelled pipeline can leave the deploy lock held. Release it with `deployctl unlock` after checking no rollout is running.",
          },
        ],
      },
      {
        group: "Architecture decisions",
        entries: [
          {
            title: "Use Postgres for the job queue",
            kind: "decision",
            content:
              "We keep background jobs in Postgres with SKIP LOCKED instead of adding a separate broker, to reduce operational load.",
          },
          {
            title: "Services must expose /healthz",
            kind: "requirement",
            content:
              "Every service exposes an unauthenticated /healthz endpoint returning 200 when it can serve traffic.",
          },
          {
            title: "March staging outage",
            kind: "incident",
            content:
              "Staging was down for 3 hours after a certificate expired. We now alert 14 days before expiry.",
          },
        ],
      },
    ],
    sessions: CONVERSATIONS["Platform engineering"]!,
  },
  {
    name: "Customer success",
    grants: { maria: "member", aiko: "admin", jonas: "viewer" },
    variableSets: [
      {
        name: "Zendesk",
        description: "Ticket export access.",
        vars: {
          ZENDESK_SUBDOMAIN: "acme-robotics",
          ZENDESK_EMAIL: "support@acme.dev",
          ZENDESK_API_TOKEN: "fake-zendesk-token-1",
        },
        updates: { ZENDESK_API_TOKEN: ["fake-zendesk-token-2"] },
      },
      {
        name: "HubSpot",
        description: "CRM read access.",
        vars: {
          HUBSPOT_PRIVATE_APP_TOKEN: "pat-fake-0001",
          HUBSPOT_PORTAL_ID: "00000001",
        },
      },
      {
        name: "Status page",
        description: "Incident posting.",
        vars: {
          STATUSPAGE_API_KEY: "fake-status-key",
          STATUSPAGE_PAGE_ID: "fakepage01",
        },
      },
    ],
    schedules: [
      {
        name: "Daily ticket digest",
        prompt: "Summarize yesterday's new tickets by theme and flag anything urgent.",
        schedule: {
          type: "calendar",
          timeZone: "Europe/Oslo",
          hour: 7,
          minute: 45,
          daysOfWeek: ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"],
        },
        variableSet: "Zendesk",
      },
      {
        name: "Churn risk report",
        prompt: "List accounts with falling usage and open escalations.",
        schedule: {
          type: "calendar",
          timeZone: "Europe/Oslo",
          hour: 10,
          minute: 0,
          daysOfWeek: ["FRIDAY"],
        },
        variableSet: "HubSpot",
      },
      {
        name: "Hourly SLA watch",
        prompt: "Check for tickets close to breaching their first-response SLA.",
        schedule: { type: "interval", everySeconds: 3600 },
        overlapPolicy: "skip",
      },
    ],
    apiKeys: [
      {
        name: "Help center widget",
        description: "Creates sessions from the help center.",
        permissions: ["sessions:create", "sessions:read"],
        expires: "future",
      },
      {
        name: "Legacy Zapier",
        description: "Old automation, no longer used.",
        permissions: ["sessions:create"],
        expires: "expired",
      },
      {
        name: "Contractor key",
        description: "Revoked when the contract ended.",
        permissions: ["workspace:read"],
        revoked: true,
      },
    ],
    instructions: [
      "Write replies in a friendly, plain tone. Never promise dates for fixes.",
      "Write replies in a friendly, plain tone. Never promise dates for fixes.\n\nAlways link the relevant help center article when one exists.",
    ],
    knowledge: [
      {
        group: "Support playbooks",
        entries: [
          {
            title: "Refund policy",
            kind: "fact",
            content:
              "Customers can request a full refund within 30 days of purchase. After that, refunds need approval from finance.",
          },
          {
            title: "Escalating to engineering",
            kind: "note",
            content:
              "Escalate when a bug blocks more than one customer or data may be lost. Include account id, steps and screenshots.",
          },
        ],
      },
    ],
    sessions: CONVERSATIONS["Customer success"]!,
  },
  {
    name: "Finance ops",
    grants: { maria: "viewer", tom: "viewer" },
    variableSets: [
      {
        name: "Accounting system",
        description: "Bookkeeping API access.",
        vars: {
          LEDGER_API_URL: "https://ledger.example.test/api",
          LEDGER_API_TOKEN: "fake-ledger-token-1",
          LEDGER_COMPANY_ID: "1001",
        },
        updates: {
          LEDGER_API_TOKEN: ["fake-ledger-token-2", "fake-ledger-token-3"],
        },
      },
      {
        name: "Bank feed",
        description: "Read-only bank transactions.",
        vars: {
          BANK_CLIENT_ID: "fake-bank-client",
          BANK_CLIENT_SECRET: "fake-bank-secret",
          BANK_ACCOUNT: "NO00 0000 0000 000",
        },
      },
      {
        name: "Stripe (test)",
        description: "Test-mode payments export.",
        vars: {
          STRIPE_SECRET_KEY: "sk_test_fakefakefake",
          STRIPE_ACCOUNT: "acct_fake0001",
        },
      },
    ],
    schedules: [
      {
        name: "Month-end close checklist",
        prompt: "Prepare the month-end close checklist and list missing receipts.",
        schedule: { type: "interval", everySeconds: 2_592_000 },
        variableSet: "Accounting system",
      },
      {
        name: "Weekly cash position",
        prompt: "Summarize the cash position across accounts.",
        schedule: {
          type: "calendar",
          timeZone: "Europe/Oslo",
          hour: 8,
          minute: 30,
          daysOfWeek: ["MONDAY"],
        },
        variableSet: "Bank feed",
      },
      {
        name: "Invoice reminders",
        prompt: "Draft reminders for invoices more than 14 days overdue.",
        schedule: {
          type: "calendar",
          timeZone: "Europe/Oslo",
          hour: 13,
          minute: 0,
          daysOfWeek: ["TUESDAY", "THURSDAY"],
        },
        overlapPolicy: "skip",
      },
    ],
    apiKeys: [
      {
        name: "Reporting export",
        description: "Nightly report export.",
        permissions: ["workspace:read", "sessions:read"],
      },
      {
        name: "Audit 2025",
        description: "Temporary key for the external audit.",
        permissions: ["workspace:read"],
        expires: "expired",
      },
    ],
    instructions: [
      "Treat all amounts as NOK unless stated otherwise. Never initiate payments.",
      "Treat all amounts as NOK unless stated otherwise. Never initiate payments.\n\nRound reported totals to whole kroner and show the source report for each figure.",
    ],
    knowledge: [
      {
        group: "Finance policies",
        entries: [
          {
            title: "Expense approval limits",
            kind: "requirement",
            content:
              "Expenses above 10 000 NOK need approval from a finance admin before reimbursement.",
          },
          {
            title: "Fiscal year",
            kind: "fact",
            content: "Acme Robotics uses the calendar year as its fiscal year.",
          },
        ],
      },
    ],
    sessions: CONVERSATIONS["Finance ops"]!,
  },
  {
    name: "Design preview",
    grants: { maria: "admin", jonas: "member", aiko: "member", tom: "viewer" },
    variableSets: [
      {
        name: "Figma",
        description: "Read design files for handoff notes.",
        vars: { FIGMA_TOKEN: "figd_fake_0001", FIGMA_TEAM_ID: "000001" },
        updates: { FIGMA_TOKEN: ["figd_fake_0002"] },
      },
      {
        name: "Preview deploys",
        description: "Vercel-like preview environment.",
        vars: {
          PREVIEW_TOKEN: "fake-preview-token",
          PREVIEW_PROJECT: "acme-web",
          PREVIEW_TEAM: "acme",
        },
      },
      {
        name: "Analytics",
        description: "Product analytics read key.",
        vars: {
          ANALYTICS_PROJECT_ID: "fake-project",
          ANALYTICS_READ_KEY: "fake-read-key",
        },
      },
      {
        name: "Empty set",
        description: "Created for the empty state.",
        vars: {},
      },
    ],
    schedules: [
      {
        name: "Screenshot regression sweep",
        prompt: "Capture screenshots of the main pages and compare with last week's baseline.",
        schedule: {
          type: "calendar",
          timeZone: "Europe/Oslo",
          hour: 6,
          minute: 0,
        },
      },
      {
        name: "Accessibility audit",
        prompt: "Run an accessibility audit of the marketing site and list new issues.",
        schedule: {
          type: "calendar",
          timeZone: "Europe/Oslo",
          hour: 11,
          minute: 15,
          daysOfWeek: ["WEDNESDAY"],
        },
        variableSet: "Preview deploys",
      },
      {
        name: "Design token drift check",
        prompt: "Compare design tokens in code with the Figma library.",
        schedule: { type: "interval", everySeconds: 21_600 },
        overlapPolicy: "skip",
        variableSet: "Figma",
      },
      {
        name: "Launch day check",
        prompt: "Verify the launch page renders on mobile and desktop.",
        schedule: { type: "once", runAt: inDays(30), timeZone: "Europe/Oslo" },
      },
    ],
    apiKeys: [
      {
        name: "Storybook bot",
        description: "Posts preview links.",
        permissions: ["workspace:read", "sessions:create", "sessions:read"],
        expires: "future",
      },
      {
        name: "Old preview hook",
        description: "Superseded by Storybook bot.",
        permissions: ["sessions:create"],
        expires: "expired",
      },
      {
        name: "Shared in chat",
        description: "Revoked after being shared in a chat.",
        permissions: ["workspace:read"],
        revoked: true,
      },
    ],
    instructions: [
      "Follow the design system: use existing components before creating new ones.",
      "Follow the design system: use existing components before creating new ones.\n\nCheck every change in light and dark mode, and at phone width.",
    ],
    knowledge: [
      {
        group: "Design system",
        entries: [
          {
            title: "Spacing scale",
            kind: "fact",
            content: "Spacing uses a 4px base: 4, 8, 12, 16, 24, 32, 48.",
          },
          {
            title: "Buttons use sentence case",
            kind: "decision",
            content: "All button labels use sentence case, never title case or all caps.",
          },
          {
            title: "Contrast requirement",
            kind: "requirement",
            content: "Text must meet WCAG AA contrast (4.5:1) in both themes.",
          },
        ],
      },
      {
        group: "Research notes",
        entries: [
          {
            title: "Onboarding interviews",
            kind: "note",
            content:
              "Five interviews with new admins: most expected to invite teammates before creating a workspace.",
          },
        ],
      },
    ],
    sessions: CONVERSATIONS["Design preview"]!,
  },
];

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
log(`Seeding ${API} (contract ${CONTRACT})`);
function siteHtml(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:32px;color:#1f2328}h1{font-size:22px}li{margin:4px 0}</style></head><body><h1>${title}</h1>${body}</body></html>`;
}

const SITE_SEEDS: {
  title: string;
  description: string;
  versions: string[];
  archived?: boolean;
}[] = [
  {
    title: "Q3 cost review",
    description: "Cloud spend by team with the three largest savings.",
    versions: [
      siteHtml("Q3 cost review", "<p>Draft.</p>"),
      siteHtml(
        "Q3 cost review",
        "<ul><li>Compute: 41%</li><li>Storage: 23%</li><li>Network: 12%</li></ul>",
      ),
    ],
  },
  {
    title: "On-call handbook",
    description: "Escalation paths and runbooks for the platform rotation.",
    versions: [siteHtml("On-call handbook", "<ol><li>Acknowledge</li><li>Triage</li></ol>")],
  },
  {
    title: "Launch countdown",
    description: "A countdown page for the spring release.",
    versions: [siteHtml("Launch countdown", "<p>12 days to go.</p>")],
    archived: true,
  },
];

const EDITABLE_SEEDS: { title: string; modality: "document" | "spreadsheet" | "presentation" }[] = [
  { title: "Incident review template", modality: "document" },
  { title: "Headcount plan 2027", modality: "spreadsheet" },
  { title: "Platform roadmap", modality: "presentation" },
];

type ArtifactPlanEntry = {
  key: string;
  /** Import the uploaded Office file as an editable artifact. */
  editable?: { modality: "document" | "spreadsheet" | "presentation"; title: string };
  /** Session that produced it: publishes files, links editable artifacts. */
  session?: string;
};

// Editable documents, spreadsheets and decks live in shared workspaces: the
// Personal workspace has no workspace membership row, and editable-artifact
// authorization currently requires one (so its owner is denied there).
const ARTIFACT_PLAN: Record<string, ArtifactPlanEntry[]> = {
  Personal: [
    { key: "latencyChart", session: "Why is p95 latency up on /checkout?" },
    { key: "pgQueueTs", session: "Migrate billing worker to the Postgres queue" },
    { key: "contract" },
    { key: "pricing" },
  ],
  "Platform engineering": [
    {
      key: "postmortemDoc",
      editable: { modality: "document", title: "INC-2291 postmortem" },
      session: "Postmortem: INC-2291 checkout outage",
    },
    {
      key: "reliabilityDeck",
      editable: { modality: "presentation", title: "Q4 reliability sprint" },
      session: "Plan the Q4 reliability sprint",
    },
    { key: "errorRateChart", session: "Postmortem: INC-2291 checkout outage" },
    { key: "pg17Doc", editable: { modality: "document", title: "Postgres 17 upgrade plan" } },
    {
      key: "awsSheet",
      editable: { modality: "spreadsheet", title: "AWS cost by service" },
      session: "Break down September AWS spend",
    },
    // The three empty editable artifacts seeded earlier get real content.
    { key: "roadmapDeck", editable: { modality: "presentation", title: "Platform roadmap" } },
    { key: "headcountSheet", editable: { modality: "spreadsheet", title: "Headcount plan 2027" } },
    {
      key: "incidentTemplateDoc",
      editable: { modality: "document", title: "Incident review template" },
    },
    { key: "awsChart", session: "Break down September AWS spend" },
    { key: "runbookMd", session: "Triage disk pressure alert on db-2" },
  ],
  "Finance ops": [
    {
      key: "spendSheet",
      editable: { modality: "spreadsheet", title: "Q3 spend by category" },
      session: "Build the Q3 spend overview",
    },
  ],
};

type SitePlanEntry = {
  key: string;
  title: string;
  description: string;
  html: string;
  marker: string;
};

const SITE_PLAN: Record<string, SitePlanEntry[]> = {
  Personal: [
    {
      key: "fleetSite",
      title: "Fleet health",
      description: "Uptime, firmware spread and robots needing attention (sample data).",
      html: FLEET_SITE_HTML,
      marker: "fleet-v1",
    },
  ],
  "Platform engineering": [
    {
      key: "costSite",
      title: "Q3 cost review",
      description: "Cloud spend by team with the three largest savings.",
      html: COST_REVIEW_HTML,
      marker: "cost-v3",
    },
    {
      key: "oncallSite",
      title: "On-call handbook",
      description: "Escalation paths and runbooks for the platform rotation.",
      html: ONCALL_HTML,
      marker: "oncall-v2",
    },
  ],
};

/** Artifact seeds that must be published/linked once sessions exist. */
const pendingSessionLinks: {
  workspaceId: string;
  accountId: string;
  session: string;
  ref: ArtifactRef;
}[] = [];

const owner = await ownerClient();

// Organization
const onboarding = await owner.get<{ state: string }>("/v1/auth/organization-onboarding");
if (onboarding.state === "required") {
  await owner.post("/v1/auth/organization-onboarding", {
    organizationName: ORG_NAME,
    operationId: randomUUID(),
  });
  log(`Created organization ${ORG_NAME}`);
}
const memberships = await owner.get<{
  memberships: {
    id: string;
    organizationId: string;
    personalWorkspaceId: string;
  }[];
}>("/v1/organization-memberships");
const ownerMembership = memberships.memberships[0] ?? fail("owner has no organization membership");
const orgId = ownerMembership.organizationId;

// Invitations + people
type Member = {
  id: string;
  email: string;
  role: string;
  status: string;
  authorizationRevision: number;
};
const listMembers = async () =>
  (await owner.get<{ members: Member[] }>(`/v1/organizations/${orgId}/members`)).members;
const listInvitations = async () =>
  (await owner.get<{ invitations: any[] }>(`/v1/organizations/${orgId}/invitations?limit=100`))
    .invitations;

for (const person of PEOPLE) {
  let members = await listMembers();
  let member = members.find((m) => m.email?.toLowerCase() === person.email);
  if (!member) {
    const invitations = await listInvitations();
    let invitation = invitations.find(
      (i) => i.targetEmail?.toLowerCase() === person.email && i.status === "pending",
    );
    if (!invitation) {
      invitation = await owner.post(`/v1/organizations/${orgId}/invitations`, {
        email: person.email,
        name: person.name,
        role: person.role,
        initialWorkspaceIds: [],
        expiresAt: inDays(14),
        operationId: randomUUID(),
      });
      log(`Invited ${person.email} as ${person.role}`);
    }
    if (person.state === "pending") continue;
    const client = await signIn(person.name, person.email, credentials.PEOPLE_PASSWORD!);
    const own = await client.get<{ invitations: any[] }>("/v1/organization-invitations");
    const mine = own.invitations.find((i) => i.id === invitation.id) ?? invitation;
    await client.post(`/v1/organization-invitations/${mine.id}/accept`, {
      expectedRevision: mine.revision,
      operationId: randomUUID(),
    });
    log(`  ${person.email} accepted the invitation`);
    members = await listMembers();
    member = members.find((m) => m.email?.toLowerCase() === person.email);
  }
  if (person.state === "pending") continue;
  if (!member) fail(`member ${person.email} missing after acceptance`);
  if (member.role !== person.role && member.status === "active") {
    member = await owner.patch<Member>(`/v1/organizations/${orgId}/members/${member.id}`, {
      kind: "change_role",
      role: person.role,
      expectedAuthorizationRevision: member.authorizationRevision,
      operationId: randomUUID(),
    });
  }
}

// Organization API key (service actor)
{
  const existing = await owner.get<any>(`/v1/organizations/${orgId}/api-keys`);
  const keys: any[] = existing.apiKeys ?? existing ?? [];
  if (!keys.some((k) => k.name === "Deploy bot")) {
    await owner.post(`/v1/organizations/${orgId}/api-keys`, {
      name: "Deploy bot",
      description: "Service actor used by the release pipeline.",
      access: "full",
    });
    log("Created organization API key Deploy bot");
  }
  if (!keys.some((k) => k.name === "Read-only reporting")) {
    await owner.post(`/v1/organizations/${orgId}/api-keys`, {
      name: "Read-only reporting",
      description: "Weekly usage report.",
      access: "read",
      expiresAt: inDays(90),
    });
  }
}

// Shared workspaces
const membersByKey = async () => {
  const members = await listMembers();
  const map: Record<string, Member> = {};
  for (const person of PEOPLE) {
    const member = members.find((m) => m.email?.toLowerCase() === person.email);
    if (member) map[person.key] = member;
  }
  return map;
};
let people = await membersByKey();

const workspaceUrls: string[] = [];
let sql: SQL | null = null;
const expiredKeyIds: string[] = [];
type ConversationPlan = {
  name: string;
  workspaceId: string;
  accountId: string;
  shells: { id: string; seed: SessionSeed }[];
  rich: { id: string; seed: RichSessionSeed & { scheduledTask?: string } }[];
};
const conversationPlan: ConversationPlan[] = [];
/** Scheduled task ids by workspace name ("Personal" for the owner's workspace). */
const taskIdsByWorkspace: Record<string, Record<string, string>> = {};

/** Variable sets by name, created through the API with their edit history. */
async function seedVariableSets(
  base: string,
  sets: (WorkspaceSeed["variableSets"][number] & {
    scope?: "workspace" | "user" | "organization";
  })[],
): Promise<Record<string, string>> {
  const existingSets = await owner.get<any>(`${base}/variable-sets`);
  const setList: any[] = Array.isArray(existingSets)
    ? existingSets
    : (existingSets.variableSets ?? []);
  const setIds: Record<string, string> = {};
  for (const set of setList) setIds[set.name] = set.id;
  for (const set of sets) {
    const scope = set.scope ?? "workspace";
    let found = setList.find((s) => s.name === set.name && s.scope === scope);
    if (!found) {
      found = await owner.post(`${base}/variable-sets`, {
        scope,
        name: set.name,
        description: set.description,
        variables: Object.entries(set.vars).map(([name, value]) => ({
          name,
          value,
        })),
      });
      for (const [name, values] of Object.entries(set.updates ?? {})) {
        for (const value of values) {
          await owner.put(`${base}/variable-sets/${found.id}/variables/${name}`, { value });
        }
      }
    }
    setIds[set.name] = found.id;
  }
  return setIds;
}
/** Variable set ids by workspace name, then set name. */
const variableSetIdsByWorkspace: Record<string, Record<string, string>> = {};

// Schedules. Every task is created paused through the API except `manual`
// ones (no Temporal schedule exists; only Run now fires them). "Display
// active" tasks are flipped to active in the database later, so the UI shows
// a live cadence while their Temporal schedule stays paused.
async function seedSchedules(
  base: string,
  workspaceName: string,
  schedules: (WorkspaceSeed["schedules"][number] & Pick<ScheduleSeed, "active">)[],
  setIds: Record<string, string>,
): Promise<Record<string, string>> {
  const tasks = await owner.get<any[]>(`${base}/scheduled-tasks`);
  const displayActive = new Set(DISPLAY_ACTIVE_SCHEDULES[workspaceName] ?? []);
  const ids: Record<string, string> = {};
  for (const task of schedules) {
    const found = tasks.find((t) => t.name === task.name);
    if (found) {
      const keepActive =
        task.active === "manual" || task.active === "display" || displayActive.has(task.name);
      if (found.status !== "paused" && !keepActive) {
        await owner.post(`${base}/scheduled-tasks/${found.id}/pause`);
      }
      ids[task.name] = found.id;
      continue;
    }
    const created = await owner.post<any>(`${base}/scheduled-tasks`, {
      name: task.name,
      status: task.active === "manual" ? "active" : "paused",
      schedule: task.schedule,
      runMode: "new_session_per_run",
      ...(task.overlapPolicy ? { overlapPolicy: task.overlapPolicy } : {}),
      ...(task.variableSet ? { variableSetId: setIds[task.variableSet] } : {}),
      agentConfig: { prompt: task.prompt },
    });
    ids[task.name] = created.id;
  }
  return ids;
}

// Knowledge collections (deterministic local embeddings only; see .env).
async function seedKnowledgeGroups(
  base: string,
  label: string,
  groups: WorkspaceSeed["knowledge"],
  scope: "workspace" | "personal",
) {
  const entries: any[] = [];
  for (let cursor: string | null = null; ;) {
    const page: any = await owner.get<any>(
      `${base}/knowledge/entries?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    entries.push(...(page.entries ?? page.items ?? []));
    cursor = page.nextCursor ?? null;
    if (!cursor) break;
  }
  const groupIds = new Map<string, string>();
  for (const group of groups) {
    let groupEntry = entries.find(
      (e) =>
        (e.revision?.title ?? e.title) === group.group && (e.revision?.kind ?? "group") === "group",
    );
    let groupId: string = groupEntry?.id ?? groupEntry?.entryId;
    const parentId = group.parent ? groupIds.get(group.parent) : undefined;
    if (group.parent && !parentId)
      fail(`Seed collection ${group.parent} must come before ${group.group}`);
    if (!groupEntry) {
      groupId = randomUUID();
      await owner.post(`${base}/knowledge/entries`, {
        operationId: randomUUID(),
        entryId: groupId,
        expectedVersion: 0,
        scope,
        entry: {
          title: group.group,
          kind: "group",
          content: `${group.group} for ${label}.`,
          ...(parentId ? { groupIds: [parentId] } : {}),
        },
      });
    }
    groupIds.set(group.group, groupId);
    for (const entry of group.entries) {
      if (entries.some((e) => (e.revision?.title ?? e.title) === entry.title)) continue;
      await owner.post(`${base}/knowledge/entries`, {
        operationId: randomUUID(),
        entryId: randomUUID(),
        expectedVersion: 0,
        scope,
        entry: { ...entry, groupIds: [groupId] },
      });
    }
  }
}

// Session shells: empty realtime sessions via the API (no model turn). The
// finished conversation history is written with SQL (see seedConversations).
async function sessionShells<T extends { title: string }>(
  base: string,
  ws: string,
  seeds: T[],
): Promise<{ id: string; seed: T }[]> {
  const sessionsPage = await owner.get<any>(`${base}/sessions?limit=200`);
  const sessions: any[] = Array.isArray(sessionsPage)
    ? sessionsPage
    : (sessionsPage.sessions ?? sessionsPage.items ?? []);
  const shells: { id: string; seed: T }[] = [];
  for (const session of seeds) {
    let id = sessions.find((s) => s.title === session.title && !s.parentSessionId)?.id as
      | string
      | undefined;
    if (!id) {
      const created = await owner.post<any>(`${base}/sessions`, {
        startMode: "realtime",
        idempotencyKey: `design-preview:${ws}:${session.title}`,
      });
      id = (created.id ?? created.session?.id) as string;
      await owner.patch(`${base}/sessions/${id}`, { title: session.title });
    }
    shells.push({ id, seed: session });
  }
  return shells;
}

for (const seed of WORKSPACES) {
  const all = await owner.get<any[]>("/v1/workspaces");
  let workspace = all.find((w) => w.kind === "shared" && w.name === seed.name);
  if (!workspace) {
    workspace = await owner.post(`/v1/organizations/${orgId}/workspaces`, {
      name: seed.name,
      operationId: randomUUID(),
    });
    log(`Created workspace ${seed.name}`);
  }
  const ws = workspace.id as string;
  const base = `/v1/workspaces/${ws}`;
  workspaceUrls.push(`${seed.name}: ${ORIGIN}/workspaces/${ws}`);

  // Access grants
  const overview = await owner.get<any>(`/v1/organizations/${orgId}/overview`);
  const wsAccess = (overview.workspaces ?? []).find((w: any) => w.id === ws);
  for (const [key, role] of Object.entries(seed.grants)) {
    const member = people[key];
    // A suspended member keeps its grants but cannot receive new ones.
    if (!member || member.status !== "active") continue;
    const current = (wsAccess?.members ?? []).find(
      (m: any) => m.organizationMembershipId === member.id,
    );
    if (current?.role === role) continue;
    await owner.put(`/v1/organizations/${orgId}/workspaces/${ws}/members/${member.id}`, {
      role,
      expectedUpdatedAt: current?.updatedAt ?? null,
      operationId: randomUUID(),
    });
  }

  // Variable sets
  const setIds = await seedVariableSets(base, [
    ...seed.variableSets,
    ...(EXTRA_VARIABLE_SETS[seed.name] ?? []),
  ]);
  variableSetIdsByWorkspace[seed.name] = setIds;

  // Schedules
  taskIdsByWorkspace[seed.name] = await seedSchedules(
    base,
    seed.name,
    [...seed.schedules, ...(EXTRA_SCHEDULES[seed.name] ?? [])],
    setIds,
  );

  // Workspace API keys
  const keys = (await owner.get<{ apiKeys: any[] }>(`${base}/api-keys`)).apiKeys;
  for (const key of seed.apiKeys) {
    let found = keys.find((k) => k.name === key.name);
    if (!found) {
      const created = await owner.post<{ apiKey: any }>(`${base}/api-keys`, {
        name: key.name,
        description: key.description,
        permissions: key.permissions,
        ...(key.expires ? { expiresAt: inDays(key.expires === "future" ? 120 : 1) } : {}),
      });
      found = created.apiKey;
      if (key.revoked) await owner.del(`${base}/api-keys/${found.id}`);
    }
    if (key.expires === "expired") expiredKeyIds.push(found.id);
  }

  // Workspace instructions: one revision per text, each activated in order.
  const policies = await owner.get<any>(`${base}/instruction-policies`);
  const revisions: any[] = policies.revisions ?? [];
  if (!revisions.some((r) => r.kind === "policy" && r.scope === "global")) {
    let head: { revisionId: string | null; activationVersion?: number } = {
      revisionId: null,
    };
    let previous: string | null = null;
    for (const [index, content] of seed.instructions.entries()) {
      const draft = await owner.post<any>(`${base}/instruction-policies/drafts`, {
        operationId: randomUUID(),
        kind: "policy",
        scope: "global",
        roleKey: null,
        content,
        supersedesRevisionId: previous,
      });
      const activated = await owner.post<any>(`${base}/instruction-policies/${draft.id}/activate`, {
        operationId: randomUUID(),
        expectedCurrentRevisionId: head.revisionId,
        ...(head.activationVersion !== undefined
          ? { expectedActivationVersion: head.activationVersion }
          : {}),
        reason:
          index === 0 ? "Initial workspace instructions" : `Revision ${index + 1}: clarified rules`,
      });
      head = {
        revisionId: activated.head.revisionId,
        activationVersion: activated.head.activationVersion,
      };
      previous = draft.id;
    }
  }

  await seedKnowledgeGroups(base, seed.name, seed.knowledge, "workspace");

  conversationPlan.push({
    name: seed.name,
    workspaceId: ws,
    accountId: workspace.accountId ?? orgId,
    shells: await sessionShells(base, ws, seed.sessions),
    rich: await sessionShells(base, ws, [
      ...(SHARED_RICH_SESSIONS[seed.name] ?? []),
      ...scheduledRunSessions(seed.name),
    ]),
  });
  log(`Seeded ${seed.name}`);
}

// Tom is suspended last so his grants exist first.
{
  people = await membersByKey();
  const tom = people.tom;
  if (tom && tom.status === "active") {
    await owner.patch(`/v1/organizations/${orgId}/members/${tom.id}`, {
      kind: "suspend",
      expectedAuthorizationRevision: tom.authorizationRevision,
      operationId: randomUUID(),
      reason: "On leave until further notice",
    });
    log("Suspended Tom Eriksen");
  }
}

// Personal workspace: rich sessions, schedules and personal Knowledge.
const personalWs = ownerMembership.personalWorkspaceId;
{
  const base = `/v1/workspaces/${personalWs}`;
  variableSetIdsByWorkspace.Personal = await seedVariableSets(
    base,
    EXTRA_VARIABLE_SETS.Personal ?? [],
  );
  taskIdsByWorkspace.Personal = await seedSchedules(
    base,
    "Personal",
    EXTRA_SCHEDULES.Personal ?? [],
    variableSetIdsByWorkspace.Personal,
  );
  await seedKnowledgeGroups(base, "Bendik's notes", PERSONAL_KNOWLEDGE, "personal");
  conversationPlan.push({
    name: "Personal",
    workspaceId: personalWs,
    accountId: orgId,
    shells: [],
    rich: await sessionShells(base, personalWs, [
      ...PERSONAL_RICH_SESSIONS,
      ...scheduledRunSessions("Personal"),
    ]),
  });
  log("Seeded Personal workspace");
}
const workspaceIdByName: Record<string, string> = Object.fromEntries(
  conversationPlan.map((plan) => [plan.name, plan.workspaceId]),
);

if (!migrationsUrl) {
  fail("no OPENGENI_MIGRATIONS_DATABASE_URL in .env.runtime; conversation history needs it.");
}
sql = new SQL(migrationsUrl);

// Expired API keys: no API sets a past expiry, so move it with SQL.
if (expiredKeyIds.length) {
  await sql`update api_keys set expires_at = now() - interval '3 days' where id in ${sql(expiredKeyIds)} and expires_at > now()`;
}

// Artifacts: static Sites and empty editable documents for Platform
// engineering, then real files (Office imports, charts, code, PDF) and richer
// Sites. Plain API writes, no sessions or model turns. Looked up by title or
// content hash so reruns reuse them.
if (workspaceIdByName["Platform engineering"]) {
  await seedArtifacts(owner, workspaceIdByName["Platform engineering"]);
}
const artifactsByWorkspace: Record<string, Record<string, ArtifactRef>> = {};
{
  const seedFiles = await buildSeedFiles();
  for (const [name, entries] of Object.entries(ARTIFACT_PLAN)) {
    const ws = workspaceIdByName[name];
    if (!ws) continue;
    artifactsByWorkspace[name] = await seedRichArtifacts(sql, ws, entries, seedFiles);
  }
  for (const [name, sites] of Object.entries(SITE_PLAN)) {
    const ws = workspaceIdByName[name];
    if (!ws) continue;
    for (const site of sites) {
      (artifactsByWorkspace[name] ??= {})[site.key] = await ensureSite(ws, site);
    }
  }
}

// Finished conversations: no API writes history without running a model, so
// the events are inserted directly, following the same session-activity commit
// gate the API uses. Nothing here creates workflow wakes or outbox rows, so no
// worker ever picks the sessions up. Sessions left waiting on a person get a
// closed turn attempt, exactly like a real paused turn (see seedWaitingTurn).
{
  let seededCount = 0;
  for (const plan of conversationPlan) {
    seededCount += await seedConversations(sql, plan, artifactsByWorkspace[plan.name] ?? {});
  }
  if (seededCount) log(`Wrote conversation history for ${seededCount} sessions`);
}

await linkArtifactsToSessions(sql);
await seedScheduleRuns(sql);
await seedPendingKnowledge(sql);
await seedUsage(sql);
await sql.close();

// Pins, folders (channels), Agent learning and connected capabilities.
await seedRailOrganization();
await seedAgentLearning();
await seedCapabilities();
await refreshScheduleAccess();
await seedIntegrations();
await seedRigs();

log("\nDone. Workspaces:");
for (const line of workspaceUrls) log(`  ${line}`);
log(`Owner Personal workspace: ${ORIGIN}/workspaces/${personalWs}`);
log(`Credentials: ${credentialsPath}`);

/** The simple exchange seeds, expressed as builder scripts. */
function exchangesScript(builder: ConversationBuilder, exchanges: Exchange[]) {
  for (const [userText, answer] of exchanges) {
    builder.user(userText, { after: 360 }).answer(answer, 30 + answer.length / 8);
  }
}

function simpleToRich(seed: SessionSeed): RichSessionSeed {
  return {
    title: seed.title,
    hoursAgo: seed.hoursAgo,
    ...(seed.unread ? { unread: true } : {}),
    ...(seed.children
      ? {
          children: seed.children.map((child, index) => ({
            key: `child${index}`,
            title: child.title,
            script: (builder: ConversationBuilder) => exchangesScript(builder, child.exchanges),
          })),
        }
      : {}),
    script: (builder) => exchangesScript(builder, seed.exchanges),
  };
}

async function seedConversations(
  db: SQL,
  plan: ConversationPlan,
  artifacts: Record<string, ArtifactRef>,
): Promise<number> {
  const ws = plan.workspaceId;
  const all: { id: string; seed: RichSessionSeed }[] = [
    ...plan.shells.map(({ id, seed }) => ({ id, seed: simpleToRich(seed) })),
    ...plan.rich,
  ];
  if (!all.length) return 0;
  let count = 0;
  await db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${"workspace-control:" + ws}, 0))`;
    await tx`select pg_advisory_xact_lock_shared(hashtextextended(${"session-tenancy:" + ws}, 0))`;
    await tx`select set_config('opengeni.session_activity_gate_state', 'open', true),
                    set_config('opengeni.session_activity_gate_workspace_id', ${ws}, true)`;
    const cursor = async (sessionId: string) => {
      const [row] = await tx`select last_sequence from session_event_cursors
        where workspace_id = ${ws} and session_id = ${sessionId}`;
      return Number(row?.last_sequence ?? 0);
    };
    const [shellRow] = await tx`select created_by_subject_id from sessions
      where workspace_id = ${ws} and id = ${all[0]!.id}`;
    const subjectId = String(shellRow.created_by_subject_id);
    const ownerInitiator = { kind: "subject" as const, label: OWNER.email, subjectId };

    const insertRows = async (sessionId: string, rows: SeedEventRow[], startAt: Date) => {
      const existing = await cursor(sessionId);
      let sequence = existing;
      const params: unknown[] = [];
      const values = rows.map((row) => {
        params.push(
          row.id,
          plan.accountId,
          ws,
          sessionId,
          row.turnId,
          row.generation,
          row.association,
          ++sequence,
          row.type,
          // Bun serializes objects bound to a jsonb parameter; do not stringify twice.
          row.payload,
          new Date(startAt.getTime() + row.offsetMs),
        );
        const n = params.length - 10;
        return `($${n}::uuid, $${n + 1}::uuid, $${n + 2}::uuid, $${n + 3}::uuid, $${n + 4}::uuid, $${n + 5}::int, $${n + 6}, $${n + 7}::int, $${n + 8}, $${n + 9}::jsonb, 1, $${n + 10}::timestamptz, $${n + 10}::timestamptz)`;
      });
      await tx.unsafe(
        `insert into session_events (id, account_id, workspace_id, session_id, turn_id, turn_generation,
           turn_association, sequence, type, payload, payload_codec_version, occurred_at, created_at)
         values ${values.join(", ")}`,
        params,
      );
      // The shell's own creation events move to the start of the conversation.
      await tx`update session_events set occurred_at = ${startAt}, created_at = ${startAt}
        where workspace_id = ${ws} and session_id = ${sessionId} and sequence <= ${existing}`;
      const lastAt = new Date(startAt.getTime() + (rows.at(-1)?.offsetMs ?? 0));
      return { lastSequence: sequence, lastAt };
    };

    const acknowledge = async (sessionId: string, sequence: number) => {
      await tx`insert into session_pins (account_id, workspace_id, subject_id, session_id, pinned,
          pinned_at, version, acknowledged_sequence, attention_version, archive_version)
        values (${plan.accountId}, ${ws}, ${subjectId}, ${sessionId}, false, null, 0, ${sequence}, 1, 0)
        on conflict (subject_id, workspace_id, session_id) do update
          set acknowledged_sequence = greatest(session_pins.acknowledged_sequence, excluded.acknowledged_sequence),
              manually_unread_through = null,
              attention_version = session_pins.attention_version + 1`;
    };

    // Children are real nested sessions copied from their parent's settings.
    const ensureChild = async (parentId: string, title: string): Promise<string> => {
      const [existing] = await tx`select id from sessions
        where workspace_id = ${ws} and parent_session_id = ${parentId} and title = ${title}`;
      if (existing) return String(existing.id);
      const childId = randomUUID();
      await tx`insert into sessions (id, status, initial_message, resources, tools, metadata, model,
          sandbox_backend, temporal_workflow_id, account_id, workspace_id, parent_session_id, sandbox_os,
          sandbox_group_id, title, title_source, tool_policy, created_by_kind, created_by_subject_id,
          created_by_context, root_session_id, nested_agent_depth, effective_max_nested_agent_depth,
          nested_agent_depth_policy_source, skills, first_party_mcp_tools, codex_compaction_mode,
          reasoning_effort, latency_mode, visibility, create_requested_visibility, variable_set_ids,
          agent_access, memory_scope, mcp_approval_policies, initial_xai_provider_account_authority_snapshot)
        select ${childId}, 'idle', '', p.resources, p.tools, '{}'::jsonb, p.model, p.sandbox_backend,
          ${"session-" + childId}, p.account_id, p.workspace_id, p.id, p.sandbox_os, gen_random_uuid(),
          ${title}, 'user', jsonb_build_object('mode', 'workspace_default', 'inheritedFromSessionId', p.id::text),
          p.created_by_kind, p.created_by_subject_id, p.created_by_context, p.root_session_id,
          p.nested_agent_depth + 1, p.effective_max_nested_agent_depth, p.nested_agent_depth_policy_source,
          p.skills, p.first_party_mcp_tools, p.codex_compaction_mode, p.reasoning_effort, p.latency_mode,
          p.visibility, p.create_requested_visibility, '[]'::jsonb, p.agent_access, p.memory_scope,
          p.mcp_approval_policies, p.initial_xai_provider_account_authority_snapshot
        from sessions p where p.workspace_id = ${ws} and p.id = ${parentId}`;
      const [created] = await tx`select payload from session_events
        where workspace_id = ${ws} and session_id = ${parentId} and sequence = 1`;
      await tx`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload,
          payload_codec_version, occurred_at, created_at)
        values (${plan.accountId}, ${ws}, ${childId}, 1, 'session.created', ${created.payload}, 1, now(), now())`;
      return childId;
    };

    // A turn waiting on a person is a real `requires_action` turn whose attempt
    // already closed (the steady state a real worker leaves behind). There is
    // no workflow wake, so nothing resumes it unless someone answers in the UI.
    const seedWaitingTurn = async (
      sessionId: string,
      builder: ConversationBuilder,
      startAt: Date,
      lastAt: Date,
    ) => {
      const turnId = builder.requiresActionTurnId!;
      const at = (row: SeedEventRow) => new Date(startAt.getTime() + row.offsetMs);
      const queued = builder.rows.find(
        (row) => row.type === "turn.queued" && row.turnId === turnId,
      )!;
      const started = builder.rows.find(
        (row) => row.type === "turn.started" && row.turnId === turnId,
      )!;
      const trigger = builder.rows.find((row) => row.id === queued.payload.triggerEventId)!;
      const attemptId = randomUUID();
      // Admission triggers accept only the live attempt of a running turn, so
      // the turn is admitted as running and then settled to requires_action in
      // the same transaction, exactly as a worker leaves it. Nothing outside
      // this transaction ever sees it running.
      await tx`insert into session_turns (id, session_id, trigger_event_id, temporal_workflow_id, status,
          source, position, prompt, model, reasoning_effort, sandbox_backend, sandbox_os, account_id,
          workspace_id, started_at, created_at, updated_at, execution_generation, active_attempt_id,
          initiator_kind, initiator_subject_id, initiator_context, initiating_human_subject_id,
          latency_mode, prompt_routing, surface)
        select ${turnId}, s.id, ${trigger.id}, coalesce(s.temporal_workflow_id, 'session-' || s.id::text),
          'running', 'user', 1, ${String(trigger.payload.text)}, s.model, s.reasoning_effort,
          s.sandbox_backend, s.sandbox_os, s.account_id, s.workspace_id, ${at(started)}, ${at(queued)},
          ${lastAt}, 1, ${attemptId}, 'subject', ${subjectId}, ${{ label: OWNER.email }}, ${subjectId},
          s.latency_mode, 'accepted_for_execution', 'web'
        from sessions s where s.workspace_id = ${ws} and s.id = ${sessionId}`;
      await tx`update sessions set active_turn_id = ${turnId}
        where workspace_id = ${ws} and id = ${sessionId}`;
      await tx`insert into session_turn_attempts (id, account_id, workspace_id, session_id, turn_id,
          execution_generation, state, temporal_workflow_id, temporal_workflow_run_id,
          temporal_activity_id, worker_id, verified_control_revision, started_at, updated_at,
          mcp_approval_policies, authority_epoch, authority_visibility,
          authority_owner_organization_membership_id)
        select ${attemptId}, s.account_id, s.workspace_id, s.id, ${turnId}, 1, 'running',
          coalesce(s.temporal_workflow_id, 'session-' || s.id::text), ${"design-preview-" + attemptId},
          'runAgentTurn-1', 'design-preview-seed', s.control_version, ${at(started)}, ${lastAt},
          s.mcp_approval_policies, s.authority_epoch, s.visibility, s.owner_organization_membership_id
        from sessions s where s.workspace_id = ${ws} and s.id = ${sessionId}`;
      await tx`update session_turn_attempts
        set state = 'closed', outcome = 'requires_action', closed_at = ${lastAt}, quiesced_at = ${lastAt},
            updated_at = ${lastAt}
        where workspace_id = ${ws} and id = ${attemptId}`;
      await tx`update session_turns set status = 'requires_action', updated_at = ${lastAt}
        where workspace_id = ${ws} and id = ${turnId}`;
      const request = builder.pendingHumanInput;
      if (request) {
        const askedAt = at(
          builder.rows.find(
            (row) =>
              row.type === "session.humanInput.requested" &&
              (row.payload.request as { id: string }).id === request.requestId,
          )!,
        );
        const questions = request.questions.map((question) => ({
          options: [],
          required: true,
          allowOther: question.kind !== "text",
          ...question,
        }));
        await tx`insert into session_human_input_requests (id, account_id, workspace_id, session_id,
            turn_id, turn_generation, creation_attempt_id, tool_call_id, status, questions, allow_skip,
            expires_at, created_at, updated_at)
          values (${request.requestId}, ${plan.accountId}, ${ws}, ${sessionId}, ${turnId}, 1, ${attemptId},
            ${request.toolCallId}, 'pending', ${questions}, ${request.allowSkip}, null, ${askedAt}, ${askedAt})`;
      }
    };

    const writeSession = async (sessionId: string, seed: RichSessionSeed, endAt: Date) => {
      const builder = new ConversationBuilder(seed.initiator ?? ownerInitiator);
      const children: Record<string, string> = {};
      for (const child of seed.children ?? []) {
        children[child.key] = await ensureChild(sessionId, child.title);
      }
      seed.script(builder, { workspaceId: ws, children, artifacts });
      const startAt = new Date(endAt.getTime() - builder.durationMs);
      const { lastSequence, lastAt } = await insertRows(sessionId, builder.rows, startAt);
      await tx`update sessions set created_at = ${startAt}, updated_at = ${lastAt}, status = ${builder.outcome}
        where workspace_id = ${ws} and id = ${sessionId}`;
      if (builder.requiresActionTurnId) await seedWaitingTurn(sessionId, builder, startAt, lastAt);

      if (!seed.unread) await acknowledge(sessionId, lastSequence);
      if (seed.goal) {
        await tx`insert into session_goals (account_id, workspace_id, session_id, status, text,
            success_criteria, evidence, paused_reason, created_by, created_at, updated_at)
          values (${plan.accountId}, ${ws}, ${sessionId}, ${seed.goal.status}, ${seed.goal.text},
            ${seed.goal.successCriteria ?? null}, ${seed.goal.evidence ?? null},
            ${seed.goal.pausedReason ?? null}, 'api', ${startAt}, ${lastAt})
          on conflict do nothing`;
      }
      count += 1;
      for (const [index, child] of (seed.children ?? []).entries()) {
        const childId = children[child.key]!;
        if ((await cursor(childId)) > 1) continue;
        await writeSession(
          childId,
          { title: child.title, hoursAgo: 0, script: (b) => child.script(b) },
          new Date(endAt.getTime() - 60_000 - index * 35_000),
        );
      }
    };

    for (const { id, seed } of all) {
      if ((await cursor(id)) > 2) continue;
      await writeSession(id, seed, new Date(Date.now() - seed.hoursAgo * 3_600_000));
    }

    // Variable sets the conversation used, as the session composer shows them.
    for (const { id, seed } of all) {
      const attach = (SESSION_VARIABLE_SETS[plan.name]?.[seed.title] ?? [])
        .map((name) => variableSetIdsByWorkspace[plan.name]?.[name])
        .filter((setId): setId is string => Boolean(setId));
      if (!attach.length) continue;
      await tx`update sessions set variable_set_ids = ${JSON.stringify(attach)}::text::jsonb,
          variable_set_id = ${attach.at(-1)!}
        where workspace_id = ${ws} and id = ${id} and variable_set_ids = '[]'::jsonb`;
    }

    // Finalize the session-activity gate exactly as the API does.
    await tx`select set_config('opengeni.session_activity_gate_state', 'preparing', true)`;
    await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
    await tx.unsafe(
      "SET CONSTRAINTS sessions_activity_insert_commit_guard, sessions_activity_update_commit_guard DEFERRED",
    );
    await tx`select set_config('opengeni.session_activity_gate_state', 'finalizing', true)`;
    await tx`with advanced as (
        update workspace_session_activity_revisions set revision = revision + 1
        where workspace_id = ${ws} returning revision)
      update sessions s set activity_revision = advanced.revision, activity_revision_pending_xid = null
      from advanced
      where s.workspace_id = ${ws} and s.activity_revision_pending_xid = pg_current_xact_id()::text::bigint`;
    await tx`select set_config('opengeni.session_activity_gate_state', 'finalized', true)`;
    await tx.unsafe(
      "SET CONSTRAINTS sessions_activity_insert_commit_guard, sessions_activity_update_commit_guard IMMEDIATE",
    );
  });
  return count;
}

// ---------------------------------------------------------------------------
// Artifacts with real content
// ---------------------------------------------------------------------------

async function uploadSeedFile(db: SQL, ws: string, file: SeedFile) {
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const find = async () =>
    (
      await db`select id, filename, content_type, size_bytes, sha256, updated_at from files
        where workspace_id = ${ws} and filename = ${file.filename} and sha256 = ${sha256}
          and status = 'ready' order by created_at limit 1`
    )[0];
  let row = await find();
  if (!row) {
    const base = `/v1/workspaces/${ws}`;
    const upload = await owner.post<any>(`${base}/files/uploads`, {
      filename: file.filename,
      contentType: file.contentType,
      sizeBytes: file.bytes.byteLength,
      sha256,
    });
    const put = await fetch(upload.putUrl, {
      method: "PUT",
      headers: upload.requiredHeaders ?? { "content-type": file.contentType },
      body: new Blob([file.bytes as unknown as ArrayBuffer]),
    });
    if (!put.ok) fail(`upload of ${file.filename} failed: ${put.status} ${await put.text()}`);
    await owner.post(`${base}/files/uploads/${upload.uploadId}/complete`);
    row = await find();
    if (!row) fail(`uploaded file ${file.filename} is not ready`);
  }
  return {
    id: String(row.id),
    filename: String(row.filename),
    contentType: String(row.content_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(file.contentType.startsWith("image/") ? { dimensions: { width: 960, height: 540 } } : {}),
  };
}

async function seedRichArtifacts(
  db: SQL,
  ws: string,
  entries: ArtifactPlanEntry[],
  files: Record<string, SeedFile>,
): Promise<Record<string, ArtifactRef>> {
  const base = `/v1/workspaces/${ws}`;
  const catalog = new Map<string, string>();
  for (const status of ["active", "archived"]) {
    const page = await owner.get<any>(`${base}/artifact-catalog?status=${status}&limit=100`);
    for (const item of page.items ?? []) catalog.set(`${item.kind}:${item.title}`, item.id);
  }
  const refs: Record<string, ArtifactRef> = {};
  let filled = 0;
  for (const entry of entries) {
    let ref: ArtifactRef;
    if (entry.editable) {
      let id = catalog.get(`${entry.editable.modality}:${entry.editable.title}`);
      if (!id) {
        const created = await owner.post<any>(`${base}/editable-artifacts`, {
          title: entry.editable.title,
          modality: entry.editable.modality,
          replicaId: "de51a9f0e0000001",
          idempotencyKey: `design-preview.${entry.editable.modality}.${entry.key}`,
        });
        id = String(created.id ?? created.artifact?.id);
      }
      // Only a never-edited artifact is filled, so reruns and human edits stay.
      const [row] = await db`select head_sequence from editable_artifacts where id = ${id}`;
      const content = LIVE_CONTENT[entry.key];
      if (content && Number(row?.head_sequence ?? 1) === 0) {
        try {
          await applyLiveBatch({
            apiBase: API,
            origin: ORIGIN,
            workspaceBase: base,
            post: (path, body) => owner.post(path, body),
            artifactId: id,
            replicaId: randomBytes(8).toString("hex"),
            batch: content,
          });
          filled++;
        } catch (error) {
          // Spreadsheet commits currently fail server-side on this stack; the
          // artifact stays empty and a later rerun fills it once that works.
          log(`  ${entry.editable.title}: content not written (${(error as Error).message})`);
        }
      }
      ref = { kind: "editable", id, href: `/workspaces/${ws}/artifacts/editable/${id}` };
    } else {
      const file = files[entry.key] ?? fail(`unknown seed file ${entry.key}`);
      const uploaded = await uploadSeedFile(db, ws, file);
      ref = { kind: "file", id: uploaded.id, href: `artifact:${uploaded.id}`, file: uploaded };
    }
    refs[entry.key] = ref;
    if (entry.session) {
      const accountId = conversationPlan.find((plan) => plan.workspaceId === ws)!.accountId;
      pendingSessionLinks.push({ workspaceId: ws, accountId, session: entry.session, ref });
    }
  }
  if (filled) log(`Wrote content into ${filled} editable artifacts`);
  return refs;
}

async function ensureSite(ws: string, site: SitePlanEntry): Promise<ArtifactRef> {
  const base = `/v1/workspaces/${ws}`;
  const page = await owner.get<any>(`${base}/artifact-catalog?status=active&limit=100`);
  const found = (page.items ?? []).find(
    (item: any) => item.kind === "site" && item.title === site.title,
  );
  const key = `design-preview:${ws}:site:${site.title}`;
  if (!found) {
    const createdSite = await owner.post<any>(`${base}/published-artifacts`, {
      title: site.title,
      description: site.description,
      html: site.html,
      idempotencyKey: `${key}:${site.marker}`,
    });
    log(`Published Site ${site.title}`);
    return {
      kind: "site",
      id: createdSite.artifact.id,
      href: `/workspaces/${ws}/artifacts/${createdSite.artifact.id}`,
      title: site.title,
      revision: createdSite.version.revision,
    };
  }
  const current = await owner.get<any>(`${base}/published-artifacts/${found.id}`);
  let revision = Number(current.artifact.currentVersion?.revision ?? 1);
  const html = await owner.get<any>(`${base}/published-artifacts/${found.id}/html`);
  if (typeof html !== "string" || !html.includes(`data-seed="${site.marker}"`)) {
    const next = await owner.post<any>(`${base}/published-artifacts/${found.id}/versions`, {
      html: site.html,
      expectedCurrentVersionId: current.artifact.currentVersion.id,
      idempotencyKey: `${key}:${site.marker}`,
    });
    revision = Number(next.version.revision);
    log(`Published ${site.title} version ${revision}`);
  }
  return {
    kind: "site",
    id: found.id,
    href: `/workspaces/${ws}/artifacts/${found.id}`,
    title: site.title,
    revision,
  };
}

/** Publish files into the catalog and link editable artifacts to their sessions. */
async function linkArtifactsToSessions(db: SQL) {
  for (const link of pendingSessionLinks) {
    const [session] = await db`select id from sessions
      where workspace_id = ${link.workspaceId} and title = ${link.session} and parent_session_id is null
      limit 1`;
    if (!session) continue;
    if (link.ref.kind === "file") {
      await db.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${link.accountId}, true),
                        set_config('opengeni.workspace_id', ${link.workspaceId}, true)`;
        const [published] = await tx`select 1 from opengeni_private.sandbox_file_publications
          where workspace_id = ${link.workspaceId} and file_id = ${link.ref.id}`;
        if (!published) {
          await tx`select opengeni_private.record_sandbox_file_publication(
            ${link.accountId}::uuid, ${link.workspaceId}::uuid, ${link.ref.id}::uuid, ${session.id}::uuid)`;
        }
      });
    } else if (link.ref.kind === "editable") {
      await db`insert into editable_artifact_session_links (account_id, workspace_id, session_id, artifact_id)
        values (${link.accountId}, ${link.workspaceId}, ${session.id}, ${link.ref.id})
        on conflict do nothing`;
    }
  }
}

// ---------------------------------------------------------------------------
// Schedule run history
// ---------------------------------------------------------------------------

async function seedScheduleRuns(db: SQL) {
  let inserted = 0;
  for (const plan of conversationPlan) {
    const tasks = taskIdsByWorkspace[plan.name] ?? {};
    const displayActive = [
      ...(DISPLAY_ACTIVE_SCHEDULES[plan.name] ?? []),
      ...(EXTRA_SCHEDULES[plan.name] ?? [])
        .filter((task) => task.active === "display")
        .map((task) => task.name),
    ];
    for (const name of displayActive) {
      const taskId = tasks[name];
      if (taskId) {
        await db`update scheduled_tasks set status = 'active'
          where workspace_id = ${plan.workspaceId} and id = ${taskId} and status = 'paused'`;
      }
    }
    for (const [name, runs] of Object.entries(SCHEDULE_RUNS[plan.name] ?? {})) {
      const taskId = tasks[name];
      if (!taskId) continue;
      const [existing] = await db`select 1 from scheduled_task_runs
        where workspace_id = ${plan.workspaceId} and task_id = ${taskId} limit 1`;
      if (existing) continue;
      await db.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock_shared(hashtextextended(${"session-tenancy:" + plan.workspaceId}, 0))`;
        // Historical terminal runs only. The admission triggers accept a run
        // only for an active task with a live execution snapshot; a finished
        // run from the past has neither, so they are bypassed for this insert.
        await tx.unsafe(
          "ALTER TABLE scheduled_task_runs DISABLE TRIGGER scheduled_agent_run_execution_admission",
        );
        await tx.unsafe(
          "ALTER TABLE scheduled_task_runs DISABLE TRIGGER scheduled_run_owner_matches",
        );
        for (const run of runs) {
          const firedAt = new Date(Date.now() - run.daysAgo * 86_400_000);
          const completedAt = new Date(firedAt.getTime() + Math.max(run.minutes, 0.2) * 60_000);
          let sessionId: string | null = null;
          const runId = randomUUID();
          if (run.session) {
            const [session] = await tx`select id, metadata from sessions
              where workspace_id = ${plan.workspaceId} and title = ${run.session.title}
                and parent_session_id is null limit 1`;
            if (session) {
              sessionId = String(session.id);
              await tx`update sessions set metadata = metadata || ${{
                scheduledTaskId: taskId,
                scheduledTaskRunId: runId,
                scheduledTaskRunMode: "new_session_per_run",
              }}::jsonb where workspace_id = ${plan.workspaceId} and id = ${sessionId}`;
            }
          }
          await tx`insert into scheduled_task_runs (id, account_id, workspace_id, task_id,
              task_authority_revision, task_execution_digest, status, trigger_type, action_kind,
              scheduled_at, fired_at, completed_at, session_id, error, created_at, updated_at)
            select ${runId}, t.account_id, t.workspace_id, t.id, t.authority_revision, t.execution_digest,
              ${run.status}, ${run.trigger ?? "scheduled"}, 'agent_turn',
              ${(run.trigger ?? "scheduled") === "scheduled" ? firedAt : null}, ${firedAt},
              ${completedAt}, ${sessionId}, ${run.error ?? null}, ${firedAt}, ${completedAt}
            from scheduled_tasks t where t.workspace_id = ${plan.workspaceId} and t.id = ${taskId}`;
          inserted++;
        }
        // Deferred FK checks must run before the table can be altered again.
        await tx.unsafe("SET CONSTRAINTS ALL IMMEDIATE");
        await tx.unsafe(
          "ALTER TABLE scheduled_task_runs ENABLE TRIGGER scheduled_agent_run_execution_admission",
        );
        await tx.unsafe(
          "ALTER TABLE scheduled_task_runs ENABLE TRIGGER scheduled_run_owner_matches",
        );
      });
    }
  }
  if (inserted) log(`Wrote ${inserted} schedule runs`);
}

// ---------------------------------------------------------------------------
// Knowledge proposals waiting for review (an agent's Review-first saves)
// ---------------------------------------------------------------------------

async function seedPendingKnowledge(db: SQL) {
  let inserted = 0;
  for (const plan of conversationPlan) {
    const seeds = PENDING_KNOWLEDGE[plan.name];
    if (!seeds?.length) continue;
    const personal = plan.name === "Personal";
    const [owned] = await db`select created_by_subject_id from sessions
      where workspace_id = ${plan.workspaceId} limit 1`;
    const ownerSubject = String(owned?.created_by_subject_id ?? "");
    const ownerKey = personal ? `personal:${ownerSubject}` : `workspace:${plan.workspaceId}`;
    for (const seed of seeds) {
      const [exists] = await db`select 1 from knowledge_entry_revisions r
        join knowledge_entries e on e.id = r.entry_id
        where e.account_id = ${plan.accountId} and r.body ->> 'title' = ${seed.title} limit 1`;
      if (exists) continue;
      const [session] = await db`select id from sessions
        where workspace_id = ${plan.workspaceId} and title = ${seed.fromSession}
          and parent_session_id is null limit 1`;
      if (!session) continue;
      const batchId = randomUUID();
      const entryId = randomUUID();
      const revisionId = randomUUID();
      const body = {
        title: seed.title,
        kind: seed.kind,
        content: seed.content,
        evidence: [],
        groupIds: [],
        relationships: [],
      };
      await db.begin(async (tx) => {
        await tx`select set_config('opengeni.account_id', ${plan.accountId}, true)`;
        await tx`insert into knowledge_review_batches (id, account_id, origin_workspace_id, owner_key,
            session_id, turn_id)
          values (${batchId}, ${plan.accountId}, ${plan.workspaceId}, ${ownerKey}, ${session.id},
            gen_random_uuid())`;
        await tx`insert into knowledge_entries (id, account_id, origin_workspace_id, scope,
            scope_workspace_id, scope_subject_id, version, latest_revision_id)
          values (${entryId}, ${plan.accountId}, ${plan.workspaceId}, ${personal ? "personal" : "workspace"},
            ${personal ? null : plan.workspaceId}, ${personal ? ownerSubject : null}, 1, ${revisionId})`;
        await tx`insert into knowledge_entry_revisions (id, account_id, entry_id, number, body, preview,
            actor, created_by_session_id, review_batch_id)
          values (${revisionId}, ${plan.accountId}, ${entryId}, 1, ${body}, ${seed.content.slice(0, 512)},
            ${{ kind: "agent", sessionId: String(session.id) }}, ${session.id}, ${batchId})`;
        await tx`insert into knowledge_entry_decisions (account_id, entry_id, revision_id, version,
            outcome, actor)
          values (${plan.accountId}, ${entryId}, ${revisionId}, 1, 'pending', ${{ kind: "agent" }})`;
        await tx`select knowledge_index_revision(${plan.accountId}::uuid, ${entryId}::uuid,
            ${revisionId}::uuid, ${`${seed.title}\n${seed.content}`})`;
      });
      inserted++;
    }
  }
  if (inserted) log(`Wrote ${inserted} Knowledge proposals waiting for review`);
}

// ---------------------------------------------------------------------------
// Usage for Insights: model calls, sandbox time and runs over 30 days
// ---------------------------------------------------------------------------

async function seedUsage(db: SQL) {
  let inserted = 0;
  const weights: Record<string, number> = {
    "Platform engineering": 1,
    Personal: 0.7,
    "Customer success": 0.45,
    "Design preview": 0.35,
    "Finance ops": 0.25,
  };
  for (const plan of conversationPlan) {
    const [seeded] = await db`select 1 from model_call_facts
      where workspace_id = ${plan.workspaceId} and source_key like 'design-preview:%' limit 1`;
    if (seeded) continue;
    const sessions = await db`select id, created_by_subject_id from sessions
      where workspace_id = ${plan.workspaceId} order by updated_at desc limit 40`;
    if (!sessions.length) continue;
    const weight = weights[plan.name] ?? 0.3;
    let seed = plan.workspaceId.charCodeAt(0);
    const random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    await db.begin(async (tx) => {
      for (let day = 29; day >= 0; day--) {
        const weekday = new Date(Date.now() - day * 86_400_000).getUTCDay();
        const busy = weekday === 0 || weekday === 6 ? 0.25 : 1;
        const calls = Math.round((6 + random() * 14) * weight * busy);
        for (let call = 0; call < calls; call++) {
          const session = sessions[Math.floor(random() * sessions.length)]!;
          const pick = random();
          let cumulative = 0;
          const model =
            USAGE_MODELS.find((candidate) => (cumulative += candidate.share) >= pick) ??
            USAGE_MODELS[0];
          const input = Math.round(8_000 + random() * 60_000);
          const cached = Math.round(input * (0.3 + random() * 0.5));
          const output = Math.round(300 + random() * 3_500);
          const reasoning = Math.round(output * random() * 0.6);
          const cost = Math.round(
            ((input - cached + output * 4) / 1000) * model.costPerKToken * 1000,
          );
          const occurredAt = new Date(
            Date.now() - day * 86_400_000 - Math.floor(random() * 10 * 3_600_000),
          );
          const turnId = randomUUID();
          const subject = String(session.created_by_subject_id);
          await tx`insert into model_call_facts (account_id, workspace_id, session_id, turn_id, source_key,
              provider, provider_api, model, billing_path, turn_source, initiator_kind, initiator_subject_id,
              input_tokens, output_tokens, cached_tokens, reasoning_tokens, total_tokens,
              priced_cost_micros, occurred_at, recorded_at)
            values (${plan.accountId}, ${plan.workspaceId}, ${session.id}, ${turnId},
              ${`design-preview:${turnId}`}, ${model.provider}, 'responses', ${model.model},
              ${model.billing}, 'user', 'subject', ${subject}, ${input}, ${output}, ${cached},
              ${reasoning}, ${input + output}, ${model.billing === "external" ? 0 : cost},
              ${occurredAt}, ${occurredAt})`;
          await tx`insert into usage_events (account_id, workspace_id, subject_id, event_type, quantity,
              unit, source_resource_type, source_resource_id, idempotency_key, occurred_at, recorded_at,
              initiator_kind, initiator_subject_id, origin)
            values (${plan.accountId}, ${plan.workspaceId}, ${subject}, 'model.tokens', ${input + output},
              'tokens', 'model', ${model.model}, ${`design-preview:tokens:${turnId}`}, ${occurredAt},
              ${occurredAt}, 'subject', ${subject}, 'user')`;
          if (model.billing !== "external") {
            await tx`insert into usage_events (account_id, workspace_id, subject_id, event_type, quantity,
                unit, source_resource_type, source_resource_id, idempotency_key, occurred_at, recorded_at,
                initiator_kind, initiator_subject_id, origin)
              values (${plan.accountId}, ${plan.workspaceId}, ${subject}, 'model.cost', ${cost},
                'usd_micros', 'model', ${model.model}, ${`design-preview:cost:${turnId}`}, ${occurredAt},
                ${occurredAt}, 'subject', ${subject}, 'user')`;
          }
          if (call % 3 === 0) {
            await tx`insert into usage_events (account_id, workspace_id, subject_id, event_type, quantity,
                unit, source_resource_type, source_resource_id, idempotency_key, occurred_at, recorded_at,
                initiator_kind, initiator_subject_id, origin)
              values (${plan.accountId}, ${plan.workspaceId}, ${subject}, 'agent_run.created', 1, 'run',
                'session', ${String(session.id)}, ${`design-preview:run:${turnId}`}, ${occurredAt},
                ${occurredAt}, 'subject', ${subject}, 'user'),
                (${plan.accountId}, ${plan.workspaceId}, ${subject}, 'sandbox.warm_seconds',
                ${Math.round(120 + random() * 1500)}, 'seconds', 'sandbox',
                ${`${randomUUID()}:1`}, ${`design-preview:warm:${turnId}`}, ${occurredAt},
                ${occurredAt}, 'subject', ${subject}, 'user')`;
          }
          inserted++;
        }
      }
    });
  }
  if (inserted) log(`Wrote ${inserted} model calls of usage history`);
}

// ---------------------------------------------------------------------------
// Rail organization, Agent learning and capabilities (public API)
// ---------------------------------------------------------------------------

async function seedRailOrganization() {
  for (const plan of conversationPlan) {
    const base = `/v1/workspaces/${plan.workspaceId}`;
    const folders = [
      ...new Set(plan.rich.map(({ seed }) => seed.folder).filter(Boolean)),
    ] as string[];
    const channels = new Map<string, string>();
    if (folders.length) {
      const existing = await owner.get<any>(`${base}/channels`);
      const list: any[] = Array.isArray(existing)
        ? existing
        : (existing.channels ?? existing.items ?? []);
      for (const channel of list) channels.set(channel.name, channel.id);
      for (const folder of folders) {
        if (channels.has(folder)) continue;
        const created = await owner.post<any>(`${base}/channels`, { name: folder });
        channels.set(folder, created.id);
      }
    }
    const page = await owner.get<any>(`${base}/sessions?limit=200`);
    const sessions: any[] = Array.isArray(page) ? page : (page.sessions ?? page.items ?? []);
    for (const { id, seed } of plan.rich) {
      const session = sessions.find((candidate) => candidate.id === id);
      if (seed.folder && session?.channelId !== channels.get(seed.folder)) {
        await owner.put(`${base}/sessions/${id}/channel`, { channelId: channels.get(seed.folder) });
      }
      if (seed.pinned && !session?.pinned && !session?.pin?.pinned) {
        await owner.put(`${base}/sessions/${id}/pin`, { pinned: true });
      }
    }
  }
}

/**
 * Connecting capabilities after the schedules exist leaves every schedule
 * "out of date". Refresh all but one, so the drift banner appears once as an
 * example. Refreshing re-freezes the schedule's tools only; it does not touch
 * the Temporal schedule.
 */
async function refreshScheduleAccess() {
  const keepDrift = "Weekly dependency update PR";
  for (const plan of conversationPlan) {
    const base = `/v1/workspaces/${plan.workspaceId}`;
    const tasks = await owner.get<any[]>(`${base}/scheduled-tasks`);
    for (const task of tasks) {
      if (task.name === keepDrift || !task.policyDrift || !task.executionDigest) continue;
      await owner.post(`${base}/scheduled-tasks/${task.id}/refresh-access`, {
        executionDigest: task.executionDigest,
      });
    }
  }
}

/**
 * Developer page: a credential provider and webhook endpoints through the
 * API (no outbound call happens on create), then settled delivery history by
 * SQL, keyed to real seeded session events. Needs workspace admin, so the
 * Personal workspace is skipped.
 */
async function seedIntegrations() {
  if (!migrationsUrl) return;
  const db = new SQL(migrationsUrl);
  let deliveries = 0;
  try {
    for (const [name, integration] of Object.entries(INTEGRATIONS)) {
      const ws = workspaceIdByName[name];
      if (!ws) continue;
      const base = `/v1/workspaces/${ws}`;
      const accountId = conversationPlan.find((plan) => plan.workspaceId === ws)!.accountId;
      if (integration.credentialProvider) {
        const current = await owner.request<any>("GET", `${base}/credential-provider`, undefined, {
          allow: [404],
        });
        if (current.status === 404 || !current.body?.provider) {
          await owner.put(`${base}/credential-provider`, integration.credentialProvider);
        }
      }
      const existing: any[] = (await owner.get<any>(`${base}/webhooks`)).webhooks ?? [];
      for (const webhook of integration.webhooks) {
        let row = existing.find((candidate) => candidate.url === webhook.url);
        if (
          row &&
          (row.description !== webhook.description ||
            [...row.eventTypes].sort().join() !== [...webhook.eventTypes].sort().join())
        ) {
          row =
            (
              await owner.patch<any>(`${base}/webhooks/${row.id}`, {
                description: webhook.description,
                eventTypes: webhook.eventTypes,
              })
            ).webhook ?? row;
        }
        if (!row) {
          row = (
            await owner.post<any>(`${base}/webhooks`, {
              url: webhook.url,
              description: webhook.description,
              eventTypes: webhook.eventTypes,
              enabled: webhook.enabled ?? true,
            })
          ).webhook;
        }
        if (webhook.history === "none") continue;
        const [seeded] = await db`select 1 from workspace_webhook_deliveries
          where workspace_id = ${ws} and webhook_id = ${row.id} limit 1`;
        if (seeded) continue;
        // Settled deliveries are pruned after seven days; keep history inside that.
        // A few of each subscribed type, newest first.
        const events = await db`select * from (
            select id, session_id, turn_id, sequence, type, payload, occurred_at,
              row_number() over (partition by type order by occurred_at desc) as rank
            from session_events
            where workspace_id = ${ws} and type in ${db(webhook.eventTypes)}
              and occurred_at > now() - interval '6 days') recent
          where rank <= 6 order by occurred_at desc limit 18`;
        for (const [index, event] of events.entries()) {
          const occurredAt = new Date(event.occurred_at);
          const payload = {
            id: event.id,
            type: event.type,
            workspaceId: ws,
            sessionId: event.session_id,
            turnId: event.turn_id,
            sequence: Number(event.sequence),
            occurredAt: occurredAt.toISOString(),
            data:
              event.type === "session.status.changed"
                ? { status: event.payload?.status ?? null }
                : {},
          };
          const failing = webhook.history === "failing" && index < 6;
          const retried = webhook.history === "healthy" && index % 7 === 3;
          const settledAt = new Date(
            occurredAt.getTime() + (failing ? 5.5 * 3_600_000 : retried ? 6_000 : 400),
          );
          await db`insert into workspace_webhook_deliveries (account_id, workspace_id, webhook_id,
              event_id, event_type, payload, attempts, next_attempt_at, delivered_at, failed_at,
              last_status, last_error, created_at)
            values (${accountId}, ${ws}, ${row.id}, ${event.id}, ${event.type}, ${payload},
              ${failing ? 12 : retried ? 2 : 1}, ${settledAt}, ${failing ? null : settledAt},
              ${failing ? settledAt : null}, ${failing ? 502 : 200},
              ${failing ? "502 Bad Gateway from pager-bridge.acme.example (upstream PagerDuty integration disabled)" : null},
              ${occurredAt})
            on conflict (webhook_id, event_id) do nothing`;
          deliveries++;
        }
      }
    }
  } finally {
    await db.close();
  }
  if (deliveries) log(`Wrote ${deliveries} webhook deliveries`);
}

/** Sandbox environments with a second version for one of them. */
async function seedRigs() {
  let created = 0;
  for (const [name, rigs] of Object.entries(RIGS)) {
    const ws = workspaceIdByName[name];
    if (!ws) continue;
    const base = `/v1/workspaces/${ws}`;
    const existing = await owner.get<any>(`${base}/rigs`);
    const list: any[] = Array.isArray(existing)
      ? existing
      : (existing.rigs ?? existing.items ?? []);
    for (const rig of rigs) {
      if (list.some((candidate) => candidate.name === rig.name)) continue;
      const setIds = (rig.variableSets ?? [])
        .map((set) => variableSetIdsByWorkspace[name]?.[set])
        .filter((id): id is string => Boolean(id));
      try {
        const createdRig = await owner.post<any>(`${base}/rigs`, {
          ...(rig.scope ? { scope: rig.scope } : {}),
          name: rig.name,
          description: rig.description,
          setupScript: rig.setupScript,
          checks: rig.checks,
          credentialHooks: rig.credentialHooks ?? [],
          defaultVariableSetIds: setIds,
        });
        if (rig.nextVersion) {
          await owner.post(`${base}/rigs/${createdRig.id}/versions`, {
            setupScript: rig.nextVersion.setupScript,
            changelog: rig.nextVersion.changelog,
          });
        }
        created++;
      } catch (error) {
        log(`  sandbox environment ${rig.name} skipped: ${(error as Error).message.slice(0, 200)}`);
      }
    }
  }
  if (created) log(`Created ${created} sandbox environments`);
}

async function seedAgentLearning() {
  const ws = workspaceIdByName["Platform engineering"];
  if (!ws) return;
  const base = `/v1/workspaces/${ws}`;
  const current = await owner.post<any>(`${base}/agent-learning/read`, { scope: "workspace" });
  if (current.settings?.knowledge === "review_first") return;
  await owner.post(`${base}/agent-learning`, {
    scope: "workspace",
    operationId: randomUUID(),
    expectedVersion: current.version,
    settings: {
      knowledge: "review_first",
      instructions: current.settings?.instructions ?? "review_first",
      skills: current.settings?.skills ?? "review_first",
    },
  });
  log("Set Platform engineering Knowledge learning to Review first");
}

/**
 * Catalog MCP servers shown as connected: a workspace connection row holding
 * a fake credential, bound through `connectionRef`. Enabling this way stores
 * the capability as auth-deferred and never contacts the provider.
 */
async function seedCapabilities() {
  const plans: Record<
    string,
    { catalogName?: string; name?: string; domain: string; description?: string }[]
  > = {
    "Platform engineering": [
      { catalogName: "Linear", domain: "linear.app" },
      { catalogName: "PagerDuty", domain: "pagerduty.com" },
      { catalogName: "Sentry", domain: "sentry.io" },
      ...(CAPABILITIES["Platform engineering"] ?? []),
    ],
    "Customer success": [{ catalogName: "HubSpot", domain: "hubspot.com" }],
    Personal: [{ catalogName: "Notion", domain: "notion.com" }, ...(CAPABILITIES.Personal ?? [])],
  };
  let enabled = 0;
  for (const [name, entries] of Object.entries(plans)) {
    const ws = workspaceIdByName[name];
    if (!ws) continue;
    const base = `/v1/workspaces/${ws}`;
    const catalog = await owner.get<any>(`${base}/capabilities`);
    const connections: any[] = (await owner.get<any>(`${base}/connections`)).connections ?? [];
    for (const entry of entries) {
      try {
        let item = (catalog.items ?? []).find((candidate: any) =>
          entry.catalogName
            ? candidate.name === entry.catalogName && candidate.providerDomain === entry.domain
            : candidate.name === entry.name,
        );
        if (!item && entry.name) {
          item = await owner.post<any>(`${base}/capabilities`, {
            kind: "mcp",
            name: entry.name,
            description: entry.description,
            endpointUrl: `https://${entry.domain}/mcp`,
            homepageUrl: `https://${entry.domain.replace(/^mcp\./, "")}`,
          });
        }
        if (!item) continue;
        if (
          (catalog.installations ?? []).some(
            (installation: any) => installation.capabilityId === item.id,
          )
        ) {
          continue;
        }
        const domain = item.providerDomain ?? entry.domain;
        let connection = connections.find(
          (candidate) => candidate.providerDomain === domain && candidate.status === "active",
        );
        if (!connection) {
          const createdConnection = await owner.post<any>(`${base}/connections`, {
            providerDomain: domain,
            kind: "api_key",
            ownership: "workspace",
            credential: {
              access_token: `design-preview-fake-${randomUUID()}`,
              token_type: "Bearer",
            },
            metadata: { designPreview: true },
          });
          connection = createdConnection.connection ?? createdConnection;
          connections.push(connection);
        }
        await owner.post(`${base}/capabilities/${encodeURIComponent(item.id)}/enable`, {
          connectionRef: { connectionId: connection.id, providerDomain: domain, kind: "api_key" },
        });
        enabled++;
      } catch (error) {
        log(
          `  capability ${entry.catalogName ?? entry.name} skipped: ${(error as Error).message.slice(0, 200)}`,
        );
      }
    }
  }
  if (enabled) log(`Connected ${enabled} capabilities`);
}

async function seedArtifacts(client: Client, ws: string) {
  const base = `/v1/workspaces/${ws}`;
  const existing = new Set<string>();
  for (const status of ["active", "archived"]) {
    const page = await client.get<any>(`${base}/artifact-catalog?status=${status}&limit=100`);
    for (const item of page.items ?? []) existing.add(`${item.kind}:${item.title}`);
  }
  let created = 0;
  for (const site of SITE_SEEDS) {
    if (existing.has(`site:${site.title}`)) continue;
    const key = `design-preview:${ws}:site:${site.title}`;
    const first = await client.post<any>(`${base}/published-artifacts`, {
      title: site.title,
      description: site.description,
      html: site.versions[0],
      idempotencyKey: key,
    });
    const id = first.artifact.id as string;
    let versionId = first.version.id as string;
    for (const [index, html] of site.versions.slice(1).entries()) {
      const next = await client.post<any>(`${base}/published-artifacts/${id}/versions`, {
        html,
        expectedCurrentVersionId: versionId,
        idempotencyKey: `${key}:v${index + 2}`,
      });
      versionId = next.version.id;
    }
    if (site.archived) {
      await client.patch(`${base}/published-artifacts/${id}/status`, {
        status: "archived",
        expectedCurrentVersionId: versionId,
        reason: "Design preview seed",
        idempotencyKey: `${key}:archive`,
      });
    }
    created++;
  }
  for (const editable of EDITABLE_SEEDS) {
    if (existing.has(`${editable.modality}:${editable.title}`)) continue;
    await client.post(`${base}/editable-artifacts`, {
      title: editable.title,
      modality: editable.modality,
      replicaId: "de51a9f0e0000001",
      idempotencyKey: `design-preview.${editable.modality}.${editable.title.replace(/[^A-Za-z0-9]+/g, "-")}`,
    });
    created++;
  }
  if (created) log(`Seeded ${created} artifacts`);
}
