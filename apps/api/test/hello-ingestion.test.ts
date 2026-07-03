import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { acquireSharedTestDatabase, MemoryEventBus, type SharedTestDatabase } from "@opengeni/testing";
import { Hello } from "@opengeni/agent-proto";
import {
  createDb,
  createEnrollment,
  getEnrollment,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  AGENT_HELLO_SUBJECT,
  handleHelloPayload,
  helloReportsDisplay,
  parseAgentHelloSubject,
  refreshEnrollmentDisplay,
  startHelloIngestion,
} from "../src/sandbox/metrics-ingestion";

// The connect-Hello DISPLAY-REFRESH consumer: an agent's Hello carries its LIVE
// capabilities, and consuming it reconciles `enrollments.has_display` to reality
// (both directions) instead of the frozen enroll-time snapshot. Pure helpers run
// always; the DB round-trip (through the REAL packages/db on a throwaway postgres,
// mirroring machines-routes.test.ts) is gated on docker.

// ── Pure helpers (no DB / broker) ─────────────────────────────────────────────

describe("parseAgentHelloSubject", () => {
  test("extracts workspaceId + agentId from agent.<ws>.<id>.hello", () => {
    expect(parseAgentHelloSubject("agent.ws-1.ag-2.hello")).toEqual({ workspaceId: "ws-1", agentId: "ag-2" });
  });
  test("the wildcard subscription subject is agent.*.*.hello", () => {
    expect(AGENT_HELLO_SUBJECT).toBe("agent.*.*.hello");
  });
  test("rejects a non-hello subject (the heartbeat plane is not the hello plane)", () => {
    expect(parseAgentHelloSubject("agent.ws.ag.events")).toBeNull();
    expect(parseAgentHelloSubject("agent.ws.hello")).toBeNull();
  });
});

describe("helloReportsDisplay", () => {
  test("desktop=true → has display", () => {
    expect(helloReportsDisplay(Hello.fromPartial({ capabilities: { desktop: true } }))).toBe(true);
  });
  test("a present Display detail (even if desktop=false) → has display", () => {
    expect(
      helloReportsDisplay(Hello.fromPartial({ capabilities: { desktop: false, display: { id: ":99", width: 1920, height: 1080, virtual: true } } })),
    ).toBe(true);
  });
  test("headless (desktop=false, no display) → no display", () => {
    expect(helloReportsDisplay(Hello.fromPartial({ capabilities: { desktop: false } }))).toBe(false);
  });
  test("absent Capabilities → no display", () => {
    expect(helloReportsDisplay(Hello.fromPartial({}))).toBe(false);
  });
  test("CAPTURE-BLOCKED (display present but desktopUnavailableReason set) → NO display", () => {
    // The 0.1.3 incident: a Mac reports a display but withholds `desktop` and sets
    // the reason when Screen Recording (TCC) is not granted. It must NOT count as a
    // usable display, so the machine is not offered a desktop it cannot capture.
    expect(
      helloReportsDisplay(
        Hello.fromPartial({
          capabilities: {
            desktop: false,
            display: { id: "0", width: 2560, height: 1440, virtual: false },
            desktopUnavailableReason: "Screen Recording permission not granted — enable it …",
          },
        }),
      ),
    ).toBe(false);
  });
  test("a capture-GRANTED desktop (reason empty) → has display", () => {
    expect(
      helloReportsDisplay(
        Hello.fromPartial({
          capabilities: { desktop: true, display: { id: "0", width: 2560, height: 1440, virtual: false }, desktopUnavailableReason: "" },
        }),
      ),
    ).toBe(true);
  });
});

// ── DB round-trip: the Hello refreshes has_display (both directions, no churn) ──

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<{ id: string }[]>`insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  return { accountId: a!.id, workspaceId: w!.id };
}

async function seedEnrollment(hasDisplay: boolean) {
  const { accountId, workspaceId } = await freshWorkspace();
  const enrollment = await createEnrollment(db, {
    accountId, workspaceId, pubkey: `ed25519:${crypto.randomUUID()}`,
    exposure: "whole-machine", hasDisplay, allowScreenControl: true, os: "linux", arch: "x86_64",
  });
  return { accountId, workspaceId, enrollment };
}

function helloPayload(agentId: string, workspaceId: string, opts: { desktop: boolean }): Uint8Array {
  return Hello.encode(
    Hello.fromPartial({ agentId, workspaceId, capabilities: { desktop: opts.desktop } }),
  ).finish();
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("hello-ingestion");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[hello-ingestion] docker unavailable, skipping DB round-trip");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch { /* noop */ }
  await shared?.release();
});

describe("refreshEnrollmentDisplay — the Hello reconciles has_display", () => {
  test("desktop=true flips a HEADLESS enrollment's has_display false → true", async () => {
    if (!available) return;
    const { workspaceId, enrollment } = await seedEnrollment(false);

    await handleHelloPayload(db, undefined, helloPayload(enrollment.id, workspaceId, { desktop: true }), `agent.${workspaceId}.${enrollment.id}.hello`);

    const after = await getEnrollment(db, workspaceId, enrollment.id);
    expect(after?.hasDisplay).toBe(true);
  });

  test("desktop=false flips a DISPLAYED enrollment's has_display true → false", async () => {
    if (!available) return;
    const { workspaceId, enrollment } = await seedEnrollment(true);

    await handleHelloPayload(db, undefined, helloPayload(enrollment.id, workspaceId, { desktop: false }), `agent.${workspaceId}.${enrollment.id}.hello`);

    const after = await getEnrollment(db, workspaceId, enrollment.id);
    expect(after?.hasDisplay).toBe(false);
  });

  test("an UNCHANGED Hello writes nothing (no churn — updatedAt untouched, updated:false)", async () => {
    if (!available) return;
    const { workspaceId, enrollment } = await seedEnrollment(true);
    const before = await getEnrollment(db, workspaceId, enrollment.id);

    // refreshEnrollmentDisplay short-circuits before issuing any UPDATE.
    const result = await refreshEnrollmentDisplay(db, { workspaceId, agentId: enrollment.id, hasDisplay: true });
    expect(result.updated).toBe(false);

    const after = await getEnrollment(db, workspaceId, enrollment.id);
    expect(after?.hasDisplay).toBe(true);
    expect(after?.updatedAt).toBe(before!.updatedAt); // no write ⇒ updatedAt unchanged
  });

  test("an unknown agentId is a no-op (no row → no write)", async () => {
    if (!available) return;
    const { workspaceId } = await seedEnrollment(false);
    const result = await refreshEnrollmentDisplay(db, { workspaceId, agentId: crypto.randomUUID(), hasDisplay: true });
    expect(result.updated).toBe(false);
  });

  test("the live consumer wiring: a Hello on agent.*.*.hello flips has_display via startHelloIngestion", async () => {
    if (!available) return;
    const { workspaceId, enrollment } = await seedEnrollment(false);
    const bus = new MemoryEventBus();
    const stop = startHelloIngestion({ db, bus, observability: undefined });
    try {
      await bus.emitAgentEvent(
        `agent.${workspaceId}.${enrollment.id}.hello`,
        helloPayload(enrollment.id, workspaceId, { desktop: true }),
      );
      const after = await getEnrollment(db, workspaceId, enrollment.id);
      expect(after?.hasDisplay).toBe(true);
    } finally {
      stop();
    }
  });
});
