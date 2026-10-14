import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  allowEnrollmentScreenControl,
  createDb,
  enrollmentMacPermissions,
  finalizeEnrollmentByToken,
  getEnrollment,
  listEnrollments,
  setEnrollmentDisplayState,
  type Database,
  type DbClient,
} from "../src/index";

// Turning screen control on for a connected machine changes only its consent
// bit, in place: same id, scope and credential generation, so the machine's
// existing credentials stay valid until its renewal picks up the consent. Runs
// as opengeni_app so FORCE RLS applies.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
  const [a] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

async function connectMachine(ws: { accountId: string; workspaceId: string }, name: string) {
  const { enrollment } = await finalizeEnrollmentByToken(db, {
    ...ws,
    pubkey: `ed25519:${name}:${crypto.randomUUID()}`,
    hasDisplay: true,
    allowScreenControl: false,
    os: "macos",
    arch: "arm64",
    sandboxName: name,
  });
  return enrollment;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("enrollment-screen-control");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[enrollment-screen-control] postgres unavailable, skipping");
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
}, 180_000);

describe("allowEnrollmentScreenControl", () => {
  test("turns consent on in place without a new credential generation", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const enrollment = await connectMachine(ws, "desk");
    const input = {
      ...ws,
      enrollmentId: enrollment.id,
      subjectId: "agent:attempt",
      sessionId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
    };

    expect(await allowEnrollmentScreenControl(db, input)).toEqual({ updated: true, active: true });
    const after = await getEnrollment(db, ws.workspaceId, enrollment.id);
    expect(after?.allowScreenControl).toBe(true);
    expect(after?.id).toBe(enrollment.id);
    expect(after?.scope).toBe(enrollment.scope);
    expect(after?.credentialGeneration).toBe(enrollment.credentialGeneration);
    expect(await listEnrollments(db, ws.workspaceId)).toHaveLength(1);

    // Already allowed: nothing to change, nothing audited twice.
    expect(await allowEnrollmentScreenControl(db, input)).toEqual({ updated: false, active: true });
    const audits = await admin<{ subject: string; metadata: Record<string, string> }[]>`
      select subject_id as subject, metadata from audit_events
      where action = 'connected_machine.screen_control.allowed' and target_id = ${enrollment.id}`;
    expect([...audits]).toEqual([
      {
        subject: "agent:attempt",
        metadata: { sessionId: input.sessionId, attemptId: input.attemptId },
      },
    ]);
  });

  test("never reaches a revoked machine or another workspace's machine", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const other = await freshWorkspace();
    const revoked = await connectMachine(ws, "old");
    const foreign = await connectMachine(other, "foreign");
    await admin`update enrollments set status = 'revoked', revoked_at = now() where id = ${revoked.id}`;

    const allow = (enrollmentId: string) =>
      allowEnrollmentScreenControl(db, { ...ws, enrollmentId, subjectId: "human:a" });
    expect(await allow(revoked.id)).toEqual({ updated: false, active: false });
    expect(await allow(foreign.id)).toEqual({ updated: false, active: false });
    expect((await getEnrollment(db, other.workspaceId, foreign.id))?.allowScreenControl).toBe(
      false,
    );
  });

  test("updates an organization machine through its origin workspace", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const enrollment = await connectMachine(ws, "shared");
    await admin`update enrollments set authority_scope = 'organization' where id = ${enrollment.id}`;

    expect(
      await allowEnrollmentScreenControl(db, {
        ...ws,
        enrollmentId: enrollment.id,
        subjectId: "human:admin",
      }),
    ).toEqual({ updated: true, active: true });
    const [row] = await admin<{ allow: boolean; scope: string; generation: number }[]>`
      select allow_screen_control as allow, authority_scope as scope,
        credential_generation::int as generation
      from enrollments where id = ${enrollment.id}`;
    expect(row).toEqual({
      allow: true,
      scope: "organization",
      generation: enrollment.credentialGeneration,
    });
  });
});

describe("Mac permission snapshots", () => {
  test("merge into runtime capabilities and only write on change", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const enrollment = await connectMachine(ws, "mac");
    const write = (accessibility: boolean) =>
      setEnrollmentDisplayState(db, {
        ...ws,
        enrollmentId: enrollment.id,
        hasDisplay: true,
        desktopUnavailableReason: null,
        runtimeDesktop: true,
        macPermissions: { screenRecording: true, accessibility, inputMonitoring: false },
      });

    expect(await write(false)).toEqual({ updated: true });
    expect(await write(false)).toEqual({ updated: false });
    let stored = await getEnrollment(db, ws.workspaceId, enrollment.id);
    expect(enrollmentMacPermissions(stored?.agentCapabilities)).toEqual({
      screenRecording: true,
      accessibility: false,
      inputMonitoring: false,
    });
    expect(stored?.agentCapabilities.desktop).toBe(true);

    expect(await write(true)).toEqual({ updated: true });
    stored = await getEnrollment(db, ws.workspaceId, enrollment.id);
    expect(enrollmentMacPermissions(stored?.agentCapabilities)?.accessibility).toBe(true);
  });

  test("are unknown until all three are reported", () => {
    expect(enrollmentMacPermissions({})).toBeNull();
    expect(enrollmentMacPermissions({ macScreenRecording: true })).toBeNull();
    expect(enrollmentMacPermissions(null)).toBeNull();
  });
});
