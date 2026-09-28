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
 *   making API keys already expired, and writing finished conversation history
 *   (user/assistant events and nested child sessions) into sessions whose
 *   shells were created by the API.
 * - Never sends a model turn: schedules are created paused, session shells are
 *   created empty in realtime start mode, and the SQL history creates no turns,
 *   workflow wakes or outbox rows, so no worker ever picks the sessions up.
 *   Sending a new message in a seeded session would start a real turn.
 *
 * Idempotent: every object is looked up by name first and reused.
 *
 * Passwords: the owner (bendik@acme.dev) password is read from, or generated
 * into, the credentials file (mode 0600). Other fake people share a derived
 * password (generated) stored in the same file.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";

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
  fail(
    "refusing to run without --yes (this writes fake data into the local dev stack).",
  );
}
const runtime = readEnvFile(resolve(repositoryRoot, ".env.runtime"));
if (!runtime.OPENGENI_API_PORT) {
  fail(
    "no .env.runtime with OPENGENI_API_PORT; start this worktree's stack with `bun run dev`.",
  );
}
const stackApi = `http://127.0.0.1:${runtime.OPENGENI_API_PORT}`;
const API = (option("--api") ?? stackApi).replace(/\/$/, "");
{
  const url = new URL(API);
  if (!LOOPBACK.has(url.hostname)) fail(`API ${API} is not loopback.`);
  if (url.port !== runtime.OPENGENI_API_PORT) {
    fail(
      `API ${API} is not this worktree's dev stack (port ${runtime.OPENGENI_API_PORT}).`,
    );
  }
}
const migrationsUrl = runtime.OPENGENI_MIGRATIONS_DATABASE_URL;
if (migrationsUrl && !LOOPBACK.has(new URL(migrationsUrl).hostname)) {
  fail("the worktree database URL is not loopback.");
}

const clientConfig = (await (
  await fetch(`${API}/v1/config/client`)
).json()) as {
  apiContractRevision: string;
  productAccessMode: string;
};
if (clientConfig.productAccessMode !== "managed") {
  fail(
    `API product access mode is ${clientConfig.productAccessMode}; expected managed.`,
  );
}
const CONTRACT = clientConfig.apiContractRevision;
// Browser origin the web dev server serves; Better Auth checks it on cookie requests.
const ORIGIN =
  readEnvFile(resolve(repositoryRoot, ".env")).OPENGENI_PUBLIC_BASE_URL ??
  "http://127.0.0.1:3000";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
const credentialsPath =
  option("--credentials") ??
  resolve(homedir(), ".config/opengeni-design-preview/credentials");
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

async function signIn(
  name: string,
  email: string,
  password: string,
): Promise<Client> {
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
    const session = await cached.request(
      "GET",
      "/v1/auth/get-session",
      undefined,
      {
        allow: [401, 403],
      },
    );
    if (session.status === 200 && session.body?.user?.email === OWNER.email)
      return cached;
  }
  const client = await signIn(
    OWNER.name,
    OWNER.email,
    credentials.OWNER_PASSWORD!,
  );
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
    entries: { title: string; kind: string; content: string }[];
  }[];
  sessions: SessionSeed[];
};

const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString();

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
        prompt:
          "Summarize new Sentry errors since the last run and group them by service.",
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
        prompt:
          "Open one pull request that bumps patch-level dependencies in the main services.",
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
        prompt:
          "List users and API keys with production access and highlight inactive ones.",
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
        permissions: [
          "workspace:read",
          "variable-sets:list",
          "variable-sets:read",
        ],
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
        prompt:
          "Summarize yesterday's new tickets by theme and flag anything urgent.",
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
        prompt:
          "Check for tickets close to breaching their first-response SLA.",
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
        prompt:
          "Prepare the month-end close checklist and list missing receipts.",
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
        prompt:
          "Capture screenshots of the main pages and compare with last week's baseline.",
        schedule: {
          type: "calendar",
          timeZone: "Europe/Oslo",
          hour: 6,
          minute: 0,
        },
      },
      {
        name: "Accessibility audit",
        prompt:
          "Run an accessibility audit of the marketing site and list new issues.",
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
            content:
              "All button labels use sentence case, never title case or all caps.",
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
const owner = await ownerClient();

// Organization
const onboarding = await owner.get<{ state: string }>(
  "/v1/auth/organization-onboarding",
);
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
const ownerMembership =
  memberships.memberships[0] ?? fail("owner has no organization membership");
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
  (await owner.get<{ members: Member[] }>(`/v1/organizations/${orgId}/members`))
    .members;
const listInvitations = async () =>
  (
    await owner.get<{ invitations: any[] }>(
      `/v1/organizations/${orgId}/invitations?limit=100`,
    )
  ).invitations;

for (const person of PEOPLE) {
  let members = await listMembers();
  let member = members.find((m) => m.email?.toLowerCase() === person.email);
  if (!member) {
    const invitations = await listInvitations();
    let invitation = invitations.find(
      (i) =>
        i.targetEmail?.toLowerCase() === person.email && i.status === "pending",
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
    const client = await signIn(
      person.name,
      person.email,
      credentials.PEOPLE_PASSWORD!,
    );
    const own = await client.get<{ invitations: any[] }>(
      "/v1/organization-invitations",
    );
    const mine =
      own.invitations.find((i) => i.id === invitation.id) ?? invitation;
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
    member = await owner.patch<Member>(
      `/v1/organizations/${orgId}/members/${member.id}`,
      {
        kind: "change_role",
        role: person.role,
        expectedAuthorizationRevision: member.authorizationRevision,
        operationId: randomUUID(),
      },
    );
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
const conversationPlan: {
  workspaceId: string;
  accountId: string;
  shells: { id: string; seed: SessionSeed }[];
}[] = [];

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
    await owner.put(
      `/v1/organizations/${orgId}/workspaces/${ws}/members/${member.id}`,
      {
        role,
        expectedUpdatedAt: current?.updatedAt ?? null,
        operationId: randomUUID(),
      },
    );
  }

  // Variable sets
  const existingSets = await owner.get<any>(`${base}/variable-sets`);
  const setList: any[] = Array.isArray(existingSets)
    ? existingSets
    : (existingSets.variableSets ?? []);
  const setIds: Record<string, string> = {};
  for (const set of seed.variableSets) {
    let found = setList.find(
      (s) => s.name === set.name && s.scope === "workspace",
    );
    if (!found) {
      found = await owner.post(`${base}/variable-sets`, {
        scope: "workspace",
        name: set.name,
        description: set.description,
        variables: Object.entries(set.vars).map(([name, value]) => ({
          name,
          value,
        })),
      });
      for (const [name, values] of Object.entries(set.updates ?? {})) {
        for (const value of values) {
          await owner.put(
            `${base}/variable-sets/${found.id}/variables/${name}`,
            { value },
          );
        }
      }
    }
    setIds[set.name] = found.id;
  }

  // Schedules (always paused)
  const tasks = await owner.get<any[]>(`${base}/scheduled-tasks`);
  for (const task of seed.schedules) {
    const found = tasks.find((t) => t.name === task.name);
    if (found) {
      if (found.status !== "paused")
        await owner.post(`${base}/scheduled-tasks/${found.id}/pause`);
      continue;
    }
    await owner.post(`${base}/scheduled-tasks`, {
      name: task.name,
      status: "paused",
      schedule: task.schedule,
      runMode: "new_session_per_run",
      ...(task.overlapPolicy ? { overlapPolicy: task.overlapPolicy } : {}),
      ...(task.variableSet ? { variableSetId: setIds[task.variableSet] } : {}),
      agentConfig: { prompt: task.prompt },
    });
  }

  // Workspace API keys
  const keys = (await owner.get<{ apiKeys: any[] }>(`${base}/api-keys`))
    .apiKeys;
  for (const key of seed.apiKeys) {
    let found = keys.find((k) => k.name === key.name);
    if (!found) {
      const created = await owner.post<{ apiKey: any }>(`${base}/api-keys`, {
        name: key.name,
        description: key.description,
        permissions: key.permissions,
        ...(key.expires
          ? { expiresAt: inDays(key.expires === "future" ? 120 : 1) }
          : {}),
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
      const draft = await owner.post<any>(
        `${base}/instruction-policies/drafts`,
        {
          operationId: randomUUID(),
          kind: "policy",
          scope: "global",
          roleKey: null,
          content,
          supersedesRevisionId: previous,
        },
      );
      const activated = await owner.post<any>(
        `${base}/instruction-policies/${draft.id}/activate`,
        {
          operationId: randomUUID(),
          expectedCurrentRevisionId: head.revisionId,
          ...(head.activationVersion !== undefined
            ? { expectedActivationVersion: head.activationVersion }
            : {}),
          reason:
            index === 0
              ? "Initial workspace instructions"
              : `Revision ${index + 1}: clarified rules`,
        },
      );
      head = {
        revisionId: activated.head.revisionId,
        activationVersion: activated.head.activationVersion,
      };
      previous = draft.id;
    }
  }

  // Knowledge (deterministic local embeddings only; see .env)
  const knowledge = await owner.get<any>(`${base}/knowledge/entries?limit=50`);
  const entries: any[] = knowledge.entries ?? knowledge.items ?? [];
  for (const group of seed.knowledge) {
    let groupEntry = entries.find(
      (e) => (e.revision?.title ?? e.title) === group.group,
    );
    let groupId: string = groupEntry?.id ?? groupEntry?.entryId;
    if (!groupEntry) {
      groupId = randomUUID();
      await owner.post(`${base}/knowledge/entries`, {
        operationId: randomUUID(),
        entryId: groupId,
        expectedVersion: 0,
        scope: "workspace",
        entry: {
          title: group.group,
          kind: "group",
          content: `${group.group} for ${seed.name}.`,
        },
      });
    }
    for (const entry of group.entries) {
      if (entries.some((e) => (e.revision?.title ?? e.title) === entry.title))
        continue;
      await owner.post(`${base}/knowledge/entries`, {
        operationId: randomUUID(),
        entryId: randomUUID(),
        expectedVersion: 0,
        scope: "workspace",
        entry: { ...entry, groupIds: [groupId] },
      });
    }
  }

  // Sessions: empty realtime shells via the API (no model turn), then the
  // finished conversation history is written with SQL (see seedConversations).
  const sessionsPage = await owner.get<any>(`${base}/sessions?limit=100`);
  const sessions: any[] = Array.isArray(sessionsPage)
    ? sessionsPage
    : (sessionsPage.sessions ?? sessionsPage.items ?? []);
  const shells: { id: string; seed: SessionSeed }[] = [];
  for (const session of seed.sessions) {
    let id = sessions.find(
      (s) => s.title === session.title && !s.parentSessionId,
    )?.id as string | undefined;
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
  conversationPlan.push({
    workspaceId: ws,
    accountId: workspace.accountId ?? orgId,
    shells,
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

// Expired API keys: no API sets a past expiry, so move it with SQL.
if (expiredKeyIds.length && migrationsUrl) {
  sql = new SQL(migrationsUrl);
  await sql`update api_keys set expires_at = now() - interval '3 days' where id in ${sql(expiredKeyIds)} and expires_at > now()`;
  await sql.close();
}

// Finished conversations: no API writes history without running a model, so
// the events are inserted directly, following the same session-activity commit
// gate the API uses. Nothing here creates turns, workflow wakes or outbox rows:
// the sessions stay idle and no worker ever picks them up.
if (migrationsUrl) {
  sql = new SQL(migrationsUrl);
  let seededCount = 0;
  for (const plan of conversationPlan)
    seededCount += await seedConversations(sql, plan);
  await sql.close();
  if (seededCount)
    log(`Wrote conversation history for ${seededCount} sessions`);
}

log("\nDone. Workspaces:");
for (const line of workspaceUrls) log(`  ${line}`);
log(
  `Owner Personal workspace: ${ORIGIN}/workspaces/${ownerMembership.personalWorkspaceId}`,
);
log(`Credentials: ${credentialsPath}`);

async function seedConversations(
  db: SQL,
  plan: {
    workspaceId: string;
    accountId: string;
    shells: { id: string; seed: SessionSeed }[];
  },
): Promise<number> {
  const ws = plan.workspaceId;
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
      where workspace_id = ${ws} and id = ${plan.shells[0]!.id}`;
    const subjectId = String(shellRow.created_by_subject_id);
    const initiator = { kind: "subject", label: OWNER.email, subjectId };

    const writeHistory = async (
      sessionId: string,
      exchanges: Exchange[],
      endAt: Date,
      unread: boolean,
    ) => {
      const minutesPerExchange = 7;
      let at = new Date(
        endAt.getTime() - exchanges.length * minutesPerExchange * 60_000,
      );
      const startAt = at;
      let sequence = await cursor(sessionId);
      const rows: [
        string,
        string | null,
        number | null,
        string | null,
        number,
        string,
        unknown,
        Date,
      ][] = [];
      for (const [index, [userText, answer]] of exchanges.entries()) {
        const userEventId = randomUUID();
        const turnId = randomUUID();
        const t = (offsetSeconds: number) =>
          new Date(at.getTime() + offsetSeconds * 1000);
        rows.push([
          userEventId,
          null,
          null,
          null,
          ++sequence,
          "user.message",
          { text: userText, routing: "accepted_for_execution", initiator },
          t(0),
        ]);
        rows.push([
          randomUUID(),
          turnId,
          null,
          null,
          ++sequence,
          "turn.queued",
          {
            source: "user",
            turnId,
            routing: "accepted_for_execution",
            initiator,
            triggerEventId: userEventId,
          },
          t(0),
        ]);
        rows.push([
          randomUUID(),
          turnId,
          1,
          "current",
          ++sequence,
          "turn.started",
          { triggerEventId: userEventId },
          t(2),
        ]);
        const done = t(40 + index * 25 + answer.length / 8);
        rows.push([
          randomUUID(),
          turnId,
          1,
          "current",
          ++sequence,
          "agent.message.completed",
          {
            text: answer,
            phase: "final_answer",
            messageId: `msg_seed_${turnId.slice(0, 8)}`,
          },
          done,
        ]);
        rows.push([
          randomUUID(),
          turnId,
          1,
          "current",
          ++sequence,
          "turn.completed",
          { output: answer },
          done,
        ]);
        rows.push([
          randomUUID(),
          turnId,
          1,
          "current",
          ++sequence,
          "session.status.changed",
          { status: "idle" },
          done,
        ]);
        at = new Date(at.getTime() + minutesPerExchange * 60_000);
      }
      const params: unknown[] = [];
      const values = rows.map((row) => {
        const [
          id,
          turnId,
          generation,
          association,
          seq,
          type,
          payload,
          occurredAt,
        ] = row;
        // Bun serializes objects bound to a jsonb parameter; do not stringify twice.
        params.push(
          id,
          plan.accountId,
          ws,
          sessionId,
          turnId,
          generation,
          association,
          seq,
          type,
          payload,
          occurredAt,
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
      const lastAt = rows.at(-1)![7];
      await tx`update session_events set occurred_at = ${startAt}, created_at = ${startAt}
        where workspace_id = ${ws} and session_id = ${sessionId} and sequence <= 2`;
      await tx`update sessions set created_at = ${startAt}, updated_at = ${lastAt}
        where workspace_id = ${ws} and id = ${sessionId}`;
      if (!unread) {
        await tx`insert into session_pins (account_id, workspace_id, subject_id, session_id, pinned,
            pinned_at, version, acknowledged_sequence, attention_version, archive_version)
          values (${plan.accountId}, ${ws}, ${subjectId}, ${sessionId}, false, null, 0, ${sequence}, 1, 0)
          on conflict (subject_id, workspace_id, session_id) do update
            set acknowledged_sequence = greatest(session_pins.acknowledged_sequence, excluded.acknowledged_sequence),
                manually_unread_through = null,
                attention_version = session_pins.attention_version + 1`;
      }
      count += 1;
    };

    for (const { id, seed } of plan.shells) {
      const endAt = new Date(Date.now() - seed.hoursAgo * 3_600_000);
      if ((await cursor(id)) <= 2)
        await writeHistory(id, seed.exchanges, endAt, seed.unread ?? false);
      for (const [index, child] of (seed.children ?? []).entries()) {
        const existing = await tx`select id from sessions
          where workspace_id = ${ws} and parent_session_id = ${id} and title = ${child.title}`;
        if (existing.length) continue;
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
            ${child.title}, 'user', jsonb_build_object('mode', 'workspace_default', 'inheritedFromSessionId', p.id::text),
            p.created_by_kind, p.created_by_subject_id, p.created_by_context, p.root_session_id,
            p.nested_agent_depth + 1, p.effective_max_nested_agent_depth, p.nested_agent_depth_policy_source,
            p.skills, p.first_party_mcp_tools, p.codex_compaction_mode, p.reasoning_effort, p.latency_mode,
            p.visibility, p.create_requested_visibility, '[]'::jsonb, p.agent_access, p.memory_scope,
            p.mcp_approval_policies, p.initial_xai_provider_account_authority_snapshot
          from sessions p where p.workspace_id = ${ws} and p.id = ${id}`;
        const [created] = await tx`select payload from session_events
          where workspace_id = ${ws} and session_id = ${id} and sequence = 1`;
        await tx`insert into session_events (account_id, workspace_id, session_id, sequence, type, payload,
            payload_codec_version, occurred_at, created_at)
          values (${plan.accountId}, ${ws}, ${childId}, 1, 'session.created', ${created.payload}, 1, now(), now())`;
        const childEnd = new Date(endAt.getTime() - (index + 1) * 4 * 60_000);
        await writeHistory(childId, child.exchanges, childEnd, false);
      }
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
