import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  type SharedTestDatabase,
} from "@opengeni/testing";
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
  helloDesktopUnavailableReason,
  helloReportsOpStream,
  helloReportsDisplay,
  parseAgentHelloSubject,
  refreshEnrollmentDisplay,
  refreshEnrollmentOpStream,
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
    expect(parseAgentHelloSubject("agent.ws-1.ag-2.hello")).toEqual({
      workspaceId: "ws-1",
      agentId: "ag-2",
    });
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
      helloReportsDisplay(
        Hello.fromPartial({
          capabilities: {
            desktop: false,
            display: { id: ":99", width: 1920, height: 1080, virtual: true },
          },
        }),
      ),
    ).toBe(true);
  });
  test("headless (desktop=false, no display) → no display", () => {
    expect(helloReportsDisplay(Hello.fromPartial({ capabilities: { desktop: false } }))).toBe(
      false,
    );
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
          capabilities: {
            desktop: true,
            display: { id: "0", width: 2560, height: 1440, virtual: false },
            desktopUnavailableReason: "",
          },
        }),
      ),
    ).toBe(true);
  });
});

describe("helloDesktopUnavailableReason", () => {
  test("a set reason is returned verbatim", () => {
    expect(
      helloDesktopUnavailableReason(
        Hello.fromPartial({
          capabilities: { desktopUnavailableReason: "Screen Recording not granted" },
        }),
      ),
    ).toBe("Screen Recording not granted");
  });
  test("the proto's non-optional empty string normalizes to null (capture permitted / headless)", () => {
    expect(
      helloDesktopUnavailableReason(Hello.fromPartial({ capabilities: { desktop: true } })),
    ).toBeNull();
  });
  test("absent Capabilities → null", () => {
    expect(helloDesktopUnavailableReason(Hello.fromPartial({}))).toBeNull();
  });
});

describe("helloReportsOpStream", () => {
  test("opStream=true → streaming exec advertised", () => {
    expect(helloReportsOpStream(Hello.fromPartial({ capabilities: { opStream: true } }))).toBe(
      true,
    );
  });
  test("opStream=false or absent Capabilities → legacy exec fallback", () => {
    expect(helloReportsOpStream(Hello.fromPartial({ capabilities: { opStream: false } }))).toBe(
      false,
    );
    expect(helloReportsOpStream(Hello.fromPartial({}))).toBe(false);
  });
});

// ── DB round-trip: the Hello refreshes has_display (both directions, no churn) ──

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

async function seedEnrollment(hasDisplay: boolean) {
  const { accountId, workspaceId } = await freshWorkspace();
  const enrollment = await createEnrollment(db, {
    accountId,
    workspaceId,
    pubkey: `ed25519:${crypto.randomUUID()}`,
    exposure: "whole-machine",
    hasDisplay,
    allowScreenControl: true,
    os: "linux",
    arch: "x86_64",
  });
  return { accountId, workspaceId, enrollment };
}

function helloPayload(
  agentId: string,
  workspaceId: string,
  opts: {
    desktop?: boolean;
    opStream?: boolean;
    desktopUnavailableReason?: string;
    display?: { id: string; width: number; height: number; virtual: boolean };
    capabilitiesAbsent?: boolean;
  },
): Uint8Array {
  return Hello.encode(
    Hello.fromPartial({
      agentId,
      workspaceId,
      ...(opts.capabilitiesAbsent
        ? {}
        : {
            capabilities: {
              desktop: opts.desktop ?? false,
              opStream: opts.opStream ?? false,
              ...(opts.desktopUnavailableReason
                ? { desktopUnavailableReason: opts.desktopUnavailableReason }
                : {}),
              ...(opts.display ? { display: opts.display } : {}),
            },
          }),
    }),
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
  } catch {
    /* noop */
  }
  await shared?.release();
});

describe("refreshEnrollmentDisplay — the Hello reconciles has_display", () => {
  test("desktop=true flips a HEADLESS enrollment's has_display false → true", async () => {
    if (!available) return;
    const { workspaceId, enrollment } = await seedEnrollment(false);

    await handleHelloPayload(
      db,
      undefined,
      helloPayload(enrollment.id, workspaceId, { desktop: true }),
      `agent.${workspaceId}.${enrollment.id}.hello`,
    );

    const after = await getEnrollment(db, workspaceId, enrollment.id);
    expect(after?.hasDisplay).toBe(true);
  });

  test("desktop=false flips a DISPLAYED enrollment's has_display true → false", async () => {
    if (!available) return;
    const { workspaceId, enrollment } = await seedEnrollment(true);

    await handleHelloPayload(
      db,
      undefined,
      helloPayload(enrollment.id, workspaceId, { desktop: false }),
      `agent.${workspaceId}.${enrollment.id}.hello`,
    );

    const after = await getEnrollment(db, workspaceId, enrollment.id);
    expect(after?.hasDisplay).toBe(false);
  });

  test("an UNCHANGED Hello writes nothing (no churn — updatedAt untouched, updated:false)", async () => {
    if (!available) return;
    const { workspaceId, enrollment } = await seedEnrollment(true);
    const before = await getEnrollment(db, workspaceId, enrollment.id);

    // refreshEnrollmentDisplay short-circuits before issuing any UPDATE.
    const result = await refreshEnrollmentDisplay(db, {
      workspaceId,
      agentId: enrollment.id,
      hasDisplay: true,
    });
    expect(result.updated).toBe(false);

    const after = await getEnrollment(db, workspaceId, enrollment.id);
    expect(after?.hasDisplay).toBe(true);
    expect(after?.updatedAt).toBe(before!.updatedAt); // no write ⇒ updatedAt unchanged
  });

  test("an unknown agentId is a no-op (no row → no write)", async () => {
    if (!available) return;
    const { workspaceId } = await seedEnrollment(false);
    const result = await refreshEnrollmentDisplay(db, {
      workspaceId,
      agentId: crypto.randomUUID(),
      hasDisplay: true,
    });
    expect(result.updated).toBe(false);
  });

  test("opStream=true flips the enrollment's op_stream false → true", async () => {
    if (!available) return;
    const { workspaceId, enrollment } = await seedEnrollment(false);

    await handleHelloPayload(
      db,
      undefined,
      helloPayload(enrollment.id, workspaceId, { desktop: false, opStream: true }),
      `agent.${workspaceId}.${enrollment.id}.hello`,
    );

    const after = await getEnrollment(db, workspaceId, enrollment.id);
    expect(after?.opStream).toBe(true);
  });

  test("an UNCHANGED op-stream Hello writes nothing (no churn — updatedAt untouched)", async () => {
    if (!available) return;
    const { workspaceId, enrollment } = await seedEnrollment(false);
    await refreshEnrollmentOpStream(db, {
      workspaceId,
      agentId: enrollment.id,
      opStream: true,
    });
    const before = await getEnrollment(db, workspaceId, enrollment.id);

    const result = await refreshEnrollmentOpStream(db, {
      workspaceId,
      agentId: enrollment.id,
      opStream: true,
    });
    expect(result.updated).toBe(false);

    const after = await getEnrollment(db, workspaceId, enrollment.id);
    expect(after?.opStream).toBe(true);
    expect(after?.updatedAt).toBe(before!.updatedAt); // no write ⇒ updatedAt unchanged
  });

  test("a Hello with absent Capabilities leaves op_stream false", async () => {
    if (!available) return;
    const { workspaceId, enrollment } = await seedEnrollment(false);
    const before = await getEnrollment(db, workspaceId, enrollment.id);

    await handleHelloPayload(
      db,
      undefined,
      helloPayload(enrollment.id, workspaceId, { capabilitiesAbsent: true }),
      `agent.${workspaceId}.${enrollment.id}.hello`,
    );

    const after = await getEnrollment(db, workspaceId, enrollment.id);
    expect(after?.opStream).toBe(false);
    expect(after?.updatedAt).toBe(before!.updatedAt); // both capability refreshes no-op
  });

  test("a CAPTURE-BLOCKED Hello persists the reason (server-visible) with has_display=false", async () => {
    if (!available) return;
    // A Mac reports a display it cannot capture (Screen Recording not granted). The
    // reason must land ON THE ROW so the Machines dashboard can show "display: capture
    // not granted" — the state must be visible server-side, not just an agent log line.
    const { workspaceId, enrollment } = await seedEnrollment(true);
    const reason = "Screen Recording permission not granted — enable it in System Settings.";

    await handleHelloPayload(
      db,
      undefined,
      helloPayload(enrollment.id, workspaceId, {
        desktop: false,
        desktopUnavailableReason: reason,
        display: { id: "0", width: 2560, height: 1440, virtual: false },
      }),
      `agent.${workspaceId}.${enrollment.id}.hello`,
    );

    const after = await getEnrollment(db, workspaceId, enrollment.id);
    expect(after?.hasDisplay).toBe(false); // a capture-blocked display is not usable
    expect(after?.desktopUnavailableReason).toBe(reason);
  });

  test("granting capture (a later reason-less Hello) CLEARS the persisted reason back to null", async () => {
    if (!available) return;
    const { workspaceId, enrollment } = await seedEnrollment(true);
    const reason = "Screen Recording permission not granted.";
    // First, the blocked state.
    await refreshEnrollmentDisplay(db, {
      workspaceId,
      agentId: enrollment.id,
      hasDisplay: false,
      desktopUnavailableReason: reason,
    });
    expect((await getEnrollment(db, workspaceId, enrollment.id))?.desktopUnavailableReason).toBe(
      reason,
    );

    // Then the user grants it: has_display true again, reason cleared.
    const result = await refreshEnrollmentDisplay(db, {
      workspaceId,
      agentId: enrollment.id,
      hasDisplay: true,
      desktopUnavailableReason: null,
    });
    expect(result.updated).toBe(true);
    const after = await getEnrollment(db, workspaceId, enrollment.id);
    expect(after?.hasDisplay).toBe(true);
    expect(after?.desktopUnavailableReason ?? null).toBeNull();
  });

  test("a reason-ONLY change (has_display steady) still writes (the reason is not lost)", async () => {
    if (!available) return;
    // has_display is already false; a NEW capture-blocked reason arriving must still
    // persist even though has_display doesn't move — the change-guard keys on BOTH fields.
    const { workspaceId, enrollment } = await seedEnrollment(false);
    const result = await refreshEnrollmentDisplay(db, {
      workspaceId,
      agentId: enrollment.id,
      hasDisplay: false,
      desktopUnavailableReason: "Screen Recording not granted.",
    });
    expect(result.updated).toBe(true);
    expect((await getEnrollment(db, workspaceId, enrollment.id))?.desktopUnavailableReason).toBe(
      "Screen Recording not granted.",
    );
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
