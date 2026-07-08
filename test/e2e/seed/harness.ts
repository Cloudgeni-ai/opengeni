// Shared seed harness (Workbench v2, dossier §16).
//
// Every seed script builds a persisted session on the LOCAL dev stack (docker
// sandbox backend) via the public SDK, then drives one or more real agent turns.
// Only the state that exists at TURN END survives — the box snapshots its
// workspace when a turn settles and restores from that snapshot on the next cold
// resume; post-turn Channel-A writes are discarded on drain. So a seed MUST bake
// its fixture into the turn itself (a precise bash prompt the agent just runs),
// never via Channel-A writes after the turn. This is also exactly what the M1
// turn-end capture reads, so seeds double as capture fixtures.
//
// Run a seed:  bun test/e2e/seed/seed-<name>.ts
// Env:
//   OPENGENI_SEED_BASE_URL       default http://127.0.0.1:8001  (dev API)
//   OPENGENI_SEED_WORKSPACE_ID   default: discovered via /v1/access/me
//   OPENGENI_SEED_API_KEY        optional; omitted in local access mode
//   OPENGENI_SEED_WEB_URL        default http://127.0.0.1:3000  (for printed links)
import { OpenGeniClient, type Session } from "@opengeni/sdk";

export const BASE_URL = process.env.OPENGENI_SEED_BASE_URL ?? "http://127.0.0.1:8001";
export const WEB_URL = process.env.OPENGENI_SEED_WEB_URL ?? "http://127.0.0.1:3000";
const API_KEY = process.env.OPENGENI_SEED_API_KEY;

export function createClient(): OpenGeniClient {
  return new OpenGeniClient({ baseUrl: BASE_URL, ...(API_KEY ? { apiKey: API_KEY } : {}) });
}

/** Resolve the workspace to seed into: env override, else the local-mode default. */
export async function resolveWorkspaceId(): Promise<string> {
  const override = process.env.OPENGENI_SEED_WORKSPACE_ID;
  if (override) return override;
  const res = await fetch(`${BASE_URL}/v1/access/me`, {
    headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
  });
  if (!res.ok) {
    throw new Error(
      `Could not resolve a workspace from ${BASE_URL}/v1/access/me (HTTP ${res.status}). ` +
        `Set OPENGENI_SEED_WORKSPACE_ID.`,
    );
  }
  const ctx = (await res.json()) as { defaultWorkspaceId?: string };
  if (!ctx.defaultWorkspaceId)
    throw new Error("access/me returned no defaultWorkspaceId; set OPENGENI_SEED_WORKSPACE_ID.");
  return ctx.defaultWorkspaceId;
}

const SETTLED = new Set(["idle", "failed", "error", "cancelled"]);

/** Poll session status until the current turn settles (idle) or fails. */
export async function waitForSettled(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  { timeoutMs = 240_000, pollMs = 3_000 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<Session> {
  const deadline = Date.now() + timeoutMs;
  let last: Session | null = null;
  while (Date.now() < deadline) {
    last = await client.getSession(workspaceId, sessionId);
    if (SETTLED.has(last.status)) return last;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for session ${sessionId} to settle (last=${last?.status}).`,
  );
}

/**
 * Create a docker-backed session whose first turn runs `bashScript` verbatim.
 * The agent is instructed to execute the script as-is and stop — deterministic
 * fixture creation with no model creativity in the loop.
 */
export async function seedSessionWithBash(
  client: OpenGeniClient,
  workspaceId: string,
  opts: { title: string; bashScript: string; origin?: string; timeoutMs?: number },
): Promise<Session> {
  const initialMessage = bashTurnPrompt(opts.bashScript);
  const session = await client.createSession(workspaceId, {
    initialMessage,
    sandboxBackend: "docker",
    metadata: { origin: opts.origin ?? "workbench-seed", seedTitle: opts.title },
  });
  const settled = await waitForSettled(
    client,
    workspaceId,
    session.id,
    opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {},
  );
  if (settled.status !== "idle") {
    throw new Error(
      `Seed "${opts.title}" turn did not reach idle (status=${settled.status}, session=${session.id}).`,
    );
  }
  return settled;
}

/** Drive a follow-up bash turn on an existing session and wait for it to settle. */
export async function driveBashTurn(
  client: OpenGeniClient,
  workspaceId: string,
  sessionId: string,
  bashScript: string,
  opts: { timeoutMs?: number } = {},
): Promise<Session> {
  await client.sendMessage(workspaceId, sessionId, bashTurnPrompt(bashScript));
  const settled = await waitForSettled(client, workspaceId, sessionId, opts);
  if (settled.status !== "idle") {
    throw new Error(
      `Follow-up bash turn did not reach idle (status=${settled.status}, session=${sessionId}).`,
    );
  }
  return settled;
}

/** A prompt that makes the agent run an exact bash script and nothing else. */
export function bashTurnPrompt(bashScript: string): string {
  return [
    "Run the following bash script in the workspace root exactly as written, using a single bash invocation.",
    "Do not add, remove, or reinterpret any command. After it completes, stop without further commentary.",
    "",
    "```bash",
    bashScript.trim(),
    "```",
  ].join("\n");
}

/** Standard seed entrypoint wrapper: prints the resulting session id + web link. */
export async function runSeed(
  name: string,
  fn: (ctx: { client: OpenGeniClient; workspaceId: string }) => Promise<Session>,
): Promise<void> {
  const client = createClient();
  const workspaceId = await resolveWorkspaceId();
  console.log(`[seed:${name}] workspace=${workspaceId} api=${BASE_URL}`);
  const session = await fn({ client, workspaceId });
  const link = `${WEB_URL}/workspaces/${workspaceId}/sessions/${session.id}`;
  console.log(`[seed:${name}] DONE session=${session.id} status=${session.status}`);
  console.log(`[seed:${name}] open: ${link}`);
}

/** Marker for the not-yet-implemented stub seeds (share the harness, no fixture yet). */
export function stubNotImplemented(name: string, plan: string): never {
  console.error(`[seed:${name}] STUB — not implemented yet.`);
  console.error(`[seed:${name}] intended fixture:\n${plan.trim()}`);
  process.exit(2);
}
