import { mkdir, chmod } from "node:fs/promises";

interface Args {
  baseUrl: string;
  email: string;
  name: string;
  password: string;
  resendApiKey: string;
  outFile: string;
  timeoutSeconds: number;
}

type JsonRecord = Record<string, any>;

const args = parseArgs(process.argv.slice(2));
const startedAt = new Date(Date.now() - 5_000);
const cookieJar = new CookieJar();

await signUp();
const verification = await waitForVerificationEmail();
await verifyEmail(verification.url);
await signIn();
const context = await getJson(new URL("/v1/access/me", args.baseUrl), true);
const accountId = stringField(context, "defaultAccountId");
const workspaceId = stringField(context, "defaultWorkspaceId");
const token = await createApiKey(workspaceId);
await writeOutput({ accountId, workspaceId, token, email: args.email, resendEmailId: verification.emailId, cookie: cookieJar.headerValue() });

console.log(JSON.stringify({
  ok: true,
  baseUrl: args.baseUrl,
  email: args.email,
  accountId,
  workspaceId,
  resendEmailId: verification.emailId,
  outFile: args.outFile,
}, null, 2));

async function signUp(): Promise<void> {
  const response = await fetch(new URL("/v1/auth/sign-up/email", args.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: args.name,
      email: args.email,
      password: args.password,
      callbackURL: args.baseUrl,
    }),
  });
  cookieJar.capture(response);
  if (!response.ok) {
    throw new Error(`sign-up/email returned HTTP ${response.status}: ${await response.text()}`);
  }
}

async function waitForVerificationEmail(): Promise<{ emailId: string; url: string }> {
  const deadline = Date.now() + args.timeoutSeconds * 1000;
  let lastDetail = "no emails listed";
  const expectedEmail = args.email.toLowerCase();
  while (Date.now() < deadline) {
    const list = await resendJson(new URL("https://api.resend.com/emails"));
    const emails = Array.isArray(list.data) ? list.data : [];
    const match = emails.find((email) => {
      const createdAt = typeof email.created_at === "string" ? new Date(email.created_at) : null;
      const to = Array.isArray(email.to) ? email.to.map((value) => String(value).toLowerCase()) : [];
      return typeof email.id === "string"
        && to.includes(expectedEmail)
        && String(email.subject ?? "").toLowerCase().includes("verify")
        && (!createdAt || createdAt >= startedAt);
    });
    if (match) {
      const email = await resendJson(new URL(`https://api.resend.com/emails/${match.id}`));
      const body = `${String(email.html ?? "")}\n${String(email.text ?? "")}`;
      const url = extractVerificationUrl(body);
      return { emailId: String(match.id), url };
    }
    lastDetail = `${emails.length} emails listed; no verification email for ${args.email}`;
    await sleep(2_000);
  }
  throw new Error(`timed out waiting for Resend verification email: ${lastDetail}`);
}

async function verifyEmail(url: string): Promise<void> {
  const response = await fetch(url, {
    headers: cookieJar.headers(),
    redirect: "manual",
  });
  cookieJar.capture(response);
  if (response.status < 200 || response.status >= 400) {
    throw new Error(`verify-email returned HTTP ${response.status}: ${await response.text()}`);
  }
}

async function signIn(): Promise<void> {
  const response = await fetch(new URL("/v1/auth/sign-in/email", args.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...cookieJar.headers() },
    body: JSON.stringify({
      email: args.email,
      password: args.password,
    }),
  });
  cookieJar.capture(response);
  if (!response.ok) {
    throw new Error(`sign-in/email returned HTTP ${response.status}: ${await response.text()}`);
  }
}

async function createApiKey(workspaceId: string): Promise<string> {
  const response = await fetch(new URL(`/v1/workspaces/${workspaceId}/api-keys`, args.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...cookieJar.headers() },
    body: JSON.stringify({
      name: `live-conformance-${new Date().toISOString()}`,
      permissions: [
        "workspace:read",
        "sessions:create",
        "sessions:read",
        "sessions:control",
        "files:upload",
        "files:read",
        "documents:manage",
        "documents:search",
        "scheduled_tasks:manage",
        "scheduled_tasks:run",
        "github:manage",
        "github:use",
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`api-keys returned HTTP ${response.status}: ${await response.text()}`);
  }
  const payload = await response.json() as JsonRecord;
  return stringField(payload, "token");
}

async function getJson(url: URL, auth = false): Promise<JsonRecord> {
  const response = await fetch(url, { headers: auth ? cookieJar.headers() : {} });
  cookieJar.capture(response);
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json() as JsonRecord;
}

async function resendJson(url: URL): Promise<JsonRecord> {
  let lastError = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${args.resendApiKey}` },
    });
    if (response.ok) {
      return await response.json() as JsonRecord;
    }
    lastError = `HTTP ${response.status}: ${await response.text()}`;
    if (response.status !== 429 && response.status < 500) {
      break;
    }
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : 1_000 * (attempt + 1);
    await sleep(delayMs);
  }
  throw new Error(`Resend ${url.pathname} returned ${lastError}`);
}

async function writeOutput(input: {
  accountId: string;
  workspaceId: string;
  token: string;
  email: string;
  resendEmailId: string;
  cookie: string;
}): Promise<void> {
  await mkdir(dirname(args.outFile), { recursive: true });
  await Bun.write(args.outFile, [
    "# Generated by scripts/managed-live-smoke.ts. Do not commit.",
    `OPENGENI_CONFORMANCE_BASE_URL=${args.baseUrl}`,
    `OPENGENI_CONFORMANCE_PRODUCT_TOKEN=${input.token}`,
    `OPENGENI_CONFORMANCE_WORKSPACE_ID=${input.workspaceId}`,
    `OPENGENI_CONFORMANCE_ACCOUNT_ID=${input.accountId}`,
    `OPENGENI_MANAGED_LIVE_EMAIL=${input.email}`,
    `OPENGENI_MANAGED_LIVE_RESEND_EMAIL_ID=${input.resendEmailId}`,
    `OPENGENI_MANAGED_LIVE_COOKIE=${shellQuote(input.cookie)}`,
    "",
  ].join("\n"));
  await chmod(args.outFile, 0o600);
}

class CookieJar {
  private readonly values = new Map<string, string>();

  capture(response: Response): void {
    const headers = response.headers as Headers & { getSetCookie?: () => string[] };
    const cookies = headers.getSetCookie?.() ?? splitCombinedSetCookie(response.headers.get("set-cookie"));
    for (const cookie of cookies) {
      const [pair] = cookie.split(";", 1);
      const index = pair?.indexOf("=") ?? -1;
      if (!pair || index <= 0) {
        continue;
      }
      this.values.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  headers(): Record<string, string> {
    const value = this.headerValue();
    if (!value) {
      return {};
    }
    return { cookie: value };
  }

  headerValue(): string {
    return [...this.values.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }
}

function splitCombinedSetCookie(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value.split(/,(?=\s*[^;,]+=)/g).map((cookie) => cookie.trim()).filter(Boolean);
}

function extractVerificationUrl(body: string): string {
  const match = body.match(/https?:\/\/[^"'<>\s]+\/v1\/auth\/verify-email[^"'<>\s]*/);
  if (!match) {
    throw new Error("verification email did not contain a /v1/auth/verify-email URL");
  }
  return match[0]!.replaceAll("&amp;", "&");
}

function parseArgs(values: string[]): Args {
  const now = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const out: Args = {
    baseUrl: process.env.OPENGENI_MANAGED_LIVE_BASE_URL ?? process.env.OPENGENI_CONFORMANCE_BASE_URL ?? "",
    email: process.env.OPENGENI_MANAGED_LIVE_EMAIL ?? `opengeni-staging-${now}@mail.opengeni.ai`,
    name: process.env.OPENGENI_MANAGED_LIVE_NAME ?? "OpenGeni Staging Smoke",
    password: process.env.OPENGENI_MANAGED_LIVE_PASSWORD ?? `OpenGeni-${crypto.randomUUID()}!9`,
    resendApiKey: process.env.OPENGENI_RESEND_API_KEY ?? "",
    outFile: process.env.OPENGENI_MANAGED_LIVE_OUT_FILE ?? ".agent/generated/staging/managed-smoke.env",
    timeoutSeconds: Number(process.env.OPENGENI_MANAGED_LIVE_TIMEOUT_SECONDS ?? 120),
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--base-url") {
      out.baseUrl = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--email") {
      out.email = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--password") {
      out.password = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--out-file") {
      out.outFile = requiredNext(values, ++index, value);
      continue;
    }
    if (value === "--timeout-seconds") {
      out.timeoutSeconds = Number(requiredNext(values, ++index, value));
      continue;
    }
    if (value.startsWith("--base-url=")) {
      out.baseUrl = value.slice("--base-url=".length);
      continue;
    }
    if (value.startsWith("--email=")) {
      out.email = value.slice("--email=".length);
      continue;
    }
    if (value.startsWith("--out-file=")) {
      out.outFile = value.slice("--out-file=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }

  if (!out.baseUrl) {
    throw new Error("Set --base-url, OPENGENI_MANAGED_LIVE_BASE_URL, or OPENGENI_CONFORMANCE_BASE_URL");
  }
  if (!out.resendApiKey) {
    throw new Error("Set OPENGENI_RESEND_API_KEY");
  }
  if (!Number.isFinite(out.timeoutSeconds) || out.timeoutSeconds <= 0) {
    throw new Error("--timeout-seconds must be positive");
  }
  return out;
}

function requiredNext(values: string[], index: number, flag: string): string {
  const next = values[index];
  if (!next) {
    throw new Error(`${flag} requires a value`);
  }
  return next;
}

function stringField(value: any, key: string): string {
  const field = value?.[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`response missing string field ${key}`);
  }
  return field;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "." : path.slice(0, index);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
