import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  approveDeviceEnrollmentRequest,
  consumeDeviceEnrollmentRequest,
  createDeviceEnrollmentRequest,
  denyDeviceEnrollmentRequest,
  getDeviceEnrollmentRequestByDeviceCode,
  getEnrollment,
  getPendingDeviceEnrollmentRequestByUserCode,
  listEnrollments,
  listSandboxes,
  createDb,
  type Database,
  type DbClient,
} from "../src/index";

// M5 (bring-your-own-compute): the 0025 device-flow enrollment-request table +
// DAOs, driven through the REAL packages/db query fns against a THROWAWAY postgres
// (same harness as sandboxes-enrollments.test.ts). Also exercises the migration
// up/down/up gate for 0025 (forward-only repo, but cleanly reversible). The package
// fns connect as opengeni_app (a NON-superuser, so FORCE RLS genuinely applies);
// accounts/workspaces are seeded as the superuser.

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
  return { accountId: a!.id, workspaceId: w!.id };
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("device-enrollment-flow");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[device-enrollment-flow] docker unavailable, skipping");
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

describe("0025 device-enrollment-requests migration shape", () => {
  test("the table exists with the consent + lifecycle columns, the partial unique user_code index, and RLS", async () => {
    if (!available) return;
    const cols = await admin<{ column_name: string; is_nullable: string; data_type: string }[]>`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_name = 'device_enrollment_requests'
      ORDER BY column_name`;
    const names = new Set(cols.map((c) => c.column_name));
    for (const required of [
      "device_code",
      "user_code",
      "account_id",
      "workspace_id",
      "pubkey",
      "os",
      "arch",
      "requested_exposure",
      "can_offer_display",
      "requests_screen_control",
      "status",
      "approved_by_subject_id",
      "approved_by_subject_label",
      "allow_screen_control",
      "approved_at",
      "enrollment_id",
      "sandbox_id",
      "expires_at",
    ]) {
      expect(names.has(required)).toBe(true);
    }
    // The partial unique index on user_code (pending-only).
    const idx = await admin<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'device_enrollment_requests'
        AND indexname = 'device_enrollment_requests_user_code_pending_idx'`;
    expect(idx.length).toBe(1);
    // RLS is forced.
    const rls = await admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'device_enrollment_requests'`;
    expect(rls[0]?.relrowsecurity).toBe(true);
    expect(rls[0]?.relforcerowsecurity).toBe(true);
    // The SECURITY DEFINER resolver exists.
    const fn = await admin<{ proname: string }[]>`
      SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'opengeni_private' AND p.proname = 'resolve_device_enrollment_request'`;
    expect(fn.length).toBe(1);
  }, 60_000);

  test("0025 rolls back + re-applies cleanly (forward-only but reversible)", async () => {
    if (!available) return;
    // DOWN: drop the table + the resolver fn (the documented reverse of 0025).
    await admin.unsafe(`
      DROP FUNCTION IF EXISTS opengeni_private.resolve_device_enrollment_request(text);
      DROP TABLE IF EXISTS device_enrollment_requests;
    `);
    let gone = await admin<{ n: number }[]>`
      SELECT count(*)::int as n FROM information_schema.tables WHERE table_name = 'device_enrollment_requests'`;
    expect(Number(gone[0]!.n)).toBe(0);
    // UP again: re-run the 0025 SQL body verbatim (re-applies clean — IF NOT EXISTS).
    // Re-running migrate() is a no-op (schema_migrations marks it applied), so apply
    // the file body directly to prove idempotent re-application.
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const body = readFileSync(
      join(here, "..", "drizzle", "0025_device_enrollment_requests.sql"),
      "utf8",
    );
    await admin.unsafe(body);
    gone = await admin<{ n: number }[]>`
      SELECT count(*)::int as n FROM information_schema.tables WHERE table_name = 'device_enrollment_requests'`;
    expect(Number(gone[0]!.n)).toBe(1);
    // Re-grant to opengeni_app (the GRANT block re-runs in the body, but the role
    // existed at migrate time; the body's DO-block grants again — assert it worked).
    const grant = await admin<{ n: number }[]>`
      SELECT count(*)::int as n FROM information_schema.role_table_grants
      WHERE table_name = 'device_enrollment_requests' AND grantee = 'opengeni_app' AND privilege_type = 'SELECT'`;
    expect(Number(grant[0]!.n)).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

describe("device-flow DAOs (start -> approve -> poll-consume + deny + lookups)", () => {
  test("create -> getByDeviceCode (resolver) -> getPendingByUserCode", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const req = await createDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      deviceCode: "dev-code-1",
      userCode: "AAAA-BBBB",
      pubkey: "ed25519:M5A",
      os: "linux",
      arch: "x86_64",
      machineName: "laptop",
      canOfferDisplay: true,
      requestsScreenControl: true,
      expiresAt: new Date(Date.now() + 600_000),
    });
    expect(req.status).toBe("pending");
    expect(req.requestedExposure).toBe("whole-machine");

    // The device_code lookup goes through the SECURITY DEFINER resolver (no
    // workspace context) then re-reads scoped — it must find the row.
    const byDevice = await getDeviceEnrollmentRequestByDeviceCode(db, "dev-code-1");
    expect(byDevice?.id).toBe(req.id);
    expect(byDevice?.canOfferDisplay).toBe(true);

    // An unknown device_code is null (not an error).
    expect(await getDeviceEnrollmentRequestByDeviceCode(db, "nope")).toBeNull();

    // The user_code lookup is workspace-scoped + pending-only.
    const byCode = await getPendingDeviceEnrollmentRequestByUserCode(db, workspaceId, "AAAA-BBBB");
    expect(byCode?.id).toBe(req.id);
  }, 60_000);

  test("approve: createEnrollment + createSandbox appear (acceptance #2); idempotent re-approve; consent recorded", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const req = await createDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      deviceCode: "dev-code-2",
      userCode: "CCCC-DDDD",
      pubkey: "ed25519:M5B",
      os: "linux",
      canOfferDisplay: true,
      requestsScreenControl: true,
      expiresAt: new Date(Date.now() + 600_000),
    });

    const approved = await approveDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      requestId: req.id,
      allowScreenControl: true,
      approvedBySubjectId: "user-123",
      approvedBySubjectLabel: "Jane",
      sandboxName: "laptop",
    });
    expect(approved.approved).toBe(true);
    expect(approved.enrollment).not.toBeNull();
    expect(approved.sandbox).not.toBeNull();
    // An enrollment row AND a sandbox row appear (acceptance #2).
    expect((await listEnrollments(db, workspaceId)).length).toBe(1);
    expect((await listSandboxes(db, workspaceId)).length).toBe(1);
    expect(approved.enrollment!.allowScreenControl).toBe(true);
    expect(approved.enrollment!.hasDisplay).toBe(true);
    expect(approved.sandbox!.kind).toBe("selfhosted");
    expect(approved.sandbox!.enrollmentId).toBe(approved.enrollment!.id);

    // The consent record (who/when/what) is stamped on the request row.
    const reread = await getDeviceEnrollmentRequestByDeviceCode(db, "dev-code-2");
    expect(reread?.status).toBe("approved");
    expect(reread?.approvedBySubjectId).toBe("user-123");
    expect(reread?.approvedBySubjectLabel).toBe("Jane");
    expect(reread?.allowScreenControl).toBe(true);
    expect(reread?.approvedAt).not.toBeNull();
    expect(reread?.enrollmentId).toBe(approved.enrollment!.id);
    expect(reread?.sandboxId).toBe(approved.sandbox!.id);

    // Idempotent re-approve (same request) reuses the SAME enrollment + sandbox — no
    // duplicate machine.
    const reApproved = await approveDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      requestId: req.id,
      allowScreenControl: true,
      approvedBySubjectId: "user-123",
      sandboxName: "laptop",
    });
    expect(reApproved.approved).toBe(true);
    expect(reApproved.enrollment!.id).toBe(approved.enrollment!.id);
    expect(reApproved.sandbox!.id).toBe(approved.sandbox!.id);
    expect((await listEnrollments(db, workspaceId)).length).toBe(1);
    expect((await listSandboxes(db, workspaceId)).length).toBe(1);
  }, 60_000);

  test("approve with screen-control OFF: enrollment.allowScreenControl=false (the consent gate)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const req = await createDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      deviceCode: "dev-code-3",
      userCode: "EEEE-FFFF",
      pubkey: "ed25519:M5C",
      os: "linux",
      canOfferDisplay: true,
      requestsScreenControl: true,
      expiresAt: new Date(Date.now() + 600_000),
    });
    const approved = await approveDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      requestId: req.id,
      allowScreenControl: false, // the user declined screen control
      approvedBySubjectId: "user-9",
      sandboxName: "headless",
    });
    expect(approved.enrollment!.allowScreenControl).toBe(false);
    // whole-machine is still mandatory.
    expect(approved.enrollment!.exposure).toBe("whole-machine");
  }, 60_000);

  test("consume: approved -> consumed is single-use (a second consume is a no-op)", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    const req = await createDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      deviceCode: "dev-code-4",
      userCode: "GGGG-HHHH",
      pubkey: "ed25519:M5D",
      expiresAt: new Date(Date.now() + 600_000),
    });
    await approveDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      requestId: req.id,
      allowScreenControl: false,
      approvedBySubjectId: "u",
      sandboxName: "m",
    });
    const c1 = await consumeDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      requestId: req.id,
    });
    expect(c1.consumed).toBe(true);
    const c2 = await consumeDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      requestId: req.id,
    });
    expect(c2.consumed).toBe(false); // already consumed
    const reread = await getDeviceEnrollmentRequestByDeviceCode(db, "dev-code-4");
    expect(reread?.status).toBe("consumed");
  }, 60_000);

  test("deny: pending -> denied; approve of an expired or denied row is a no-op", async () => {
    if (!available) return;
    const { accountId, workspaceId } = await freshWorkspace();
    // deny
    const denyReq = await createDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      deviceCode: "dev-code-5",
      userCode: "IIII-JJJJ",
      pubkey: "ed25519:M5E",
      expiresAt: new Date(Date.now() + 600_000),
    });
    expect(
      (await denyDeviceEnrollmentRequest(db, { accountId, workspaceId, requestId: denyReq.id }))
        .denied,
    ).toBe(true);
    expect(
      (await denyDeviceEnrollmentRequest(db, { accountId, workspaceId, requestId: denyReq.id }))
        .denied,
    ).toBe(false);
    // approve of a denied row → no-op.
    const afterDeny = await approveDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      requestId: denyReq.id,
      allowScreenControl: false,
      approvedBySubjectId: "u",
      sandboxName: "m",
    });
    expect(afterDeny.approved).toBe(false);

    // expired pending → approve no-op.
    const expReq = await createDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      deviceCode: "dev-code-6",
      userCode: "KKKK-LLLL",
      pubkey: "ed25519:M5F",
      expiresAt: new Date(Date.now() - 1_000), // already expired
    });
    const afterExpire = await approveDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      requestId: expReq.id,
      allowScreenControl: false,
      approvedBySubjectId: "u",
      sandboxName: "m",
    });
    expect(afterExpire.approved).toBe(false);
    expect((await listEnrollments(db, workspaceId)).length).toBe(0);
  }, 60_000);

  test("RLS: workspace B cannot read workspace A's pending request by user_code", async () => {
    if (!available) return;
    const a = await freshWorkspace();
    const b = await freshWorkspace();
    await createDeviceEnrollmentRequest(db, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      deviceCode: "dev-code-iso",
      userCode: "ISOX-ISOY",
      pubkey: "ed25519:ISO",
      expiresAt: new Date(Date.now() + 600_000),
    });
    expect(
      await getPendingDeviceEnrollmentRequestByUserCode(db, b.workspaceId, "ISOX-ISOY"),
    ).toBeNull();
    expect(
      await getPendingDeviceEnrollmentRequestByUserCode(db, a.workspaceId, "ISOX-ISOY"),
    ).not.toBeNull();
  }, 60_000);
});

describe("the approved enrollment drives the M3 consent_required -> online transition", () => {
  test("screen-control ON enrollment is consented; OFF is consent_required (via selfhostedLiveness)", async () => {
    if (!available) return;
    const { selfhostedLiveness } = await import("@opengeni/runtime/sandbox");
    const { accountId, workspaceId } = await freshWorkspace();

    // Approve a machine WITH screen control → the enrollment is fully consented.
    const onReq = await createDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      deviceCode: "dc-on",
      userCode: "ON11-ON22",
      pubkey: "ed25519:ON",
      canOfferDisplay: true,
      requestsScreenControl: true,
      expiresAt: new Date(Date.now() + 600_000),
    });
    const on = await approveDeviceEnrollmentRequest(db, {
      accountId,
      workspaceId,
      requestId: onReq.id,
      allowScreenControl: true,
      approvedBySubjectId: "u",
      sandboxName: "m",
    });
    const onEnrollment = await getEnrollment(db, workspaceId, on.enrollment!.id);
    const onState = selfhostedLiveness({ enrollment: onEnrollment!, probeResponded: true });
    expect(onState.state).toBe("online");
    expect(onState.consented).toBe(true); // whole-machine + screen-control
    expect(onState.hasDisplay).toBe(true);

    // Approve a machine WITHOUT screen control → online but NOT consented for input
    // (the M3 negotiation stamps consent_required on the desktop/computer-use cells).
    const { accountId: a2, workspaceId: w2 } = await freshWorkspace();
    const offReq = await createDeviceEnrollmentRequest(db, {
      accountId: a2,
      workspaceId: w2,
      deviceCode: "dc-off",
      userCode: "OF11-OF22",
      pubkey: "ed25519:OFF",
      canOfferDisplay: true,
      requestsScreenControl: true,
      expiresAt: new Date(Date.now() + 600_000),
    });
    const off = await approveDeviceEnrollmentRequest(db, {
      accountId: a2,
      workspaceId: w2,
      requestId: offReq.id,
      allowScreenControl: false,
      approvedBySubjectId: "u",
      sandboxName: "m",
    });
    const offEnrollment = await getEnrollment(db, w2, off.enrollment!.id);
    const offState = selfhostedLiveness({ enrollment: offEnrollment!, probeResponded: true });
    expect(offState.state).toBe("online");
    expect(offState.consented).toBe(false); // screen-control declined
  }, 60_000);
});
