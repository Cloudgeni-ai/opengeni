import { describe, expect, spyOn, test } from "bun:test";
import { signDelegatedAccessToken, type AccessContext } from "@opengeni/contracts";
import * as opengeniDb from "@opengeni/db";
import { testSettings } from "@opengeni/testing";
import { Hono } from "hono";
import { requireAccessGrant, type AccessDeps } from "../src/access";
import { recordEvidence } from "../src/access/direct-session-evidence";
import {
  requireOrganizationGovernanceAdmin,
  requireOrganizationGovernanceAdminOrLockedReplay,
  requireOrganizationRecoveryCustodian,
  requireOrganizationRecoveryCustodianOrReplay,
} from "../src/domain/organization-governance";

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";
const SECRET = "organization-governance-access-test-secret";

function deps(): AccessDeps {
  return {
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: SECRET,
      organizationGovernanceEnabled: true,
    }),
    db: {} as opengeniDb.Database,
    governanceDb: {} as opengeniDb.Database,
  };
}

async function lockedRequest(subjectId: string): Promise<Response> {
  const token = await signDelegatedAccessToken(SECRET, {
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    subjectId,
    permissions: ["workspace:read"],
    principalKind: "service",
    exp: Math.floor(Date.now() / 1_000) + 60,
  });
  const app = new Hono();
  app.get("/workspace", async (context) => {
    await requireAccessGrant(context, deps(), WORKSPACE_ID, "workspace:read");
    return context.text("unexpected access");
  });
  return await app.request("http://example.test/workspace", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("organization governance access fence", () => {
  test("denies ordinary human and non-human delegated workspace authority while locked", async () => {
    const status = spyOn(opengeniDb, "getOrganizationGovernanceStatus").mockResolvedValue({
      accountId: ACCOUNT_ID,
      kind: "team",
      state: "governance_locked",
      governanceRevision: 7,
      authoritySubjectId: "user:owner",
      authorizationInvalidatedAt: null,
    });
    try {
      for (const subjectId of ["user:custodian", "service:automation"]) {
        const response = await lockedRequest(subjectId);
        expect(response.status).toBe(423);
        expect(await response.text()).toContain("organization governance is locked");
      }
    } finally {
      status.mockRestore();
    }
  });

  test("rejects delegated authority issued before the recovery invalidation", async () => {
    const status = spyOn(opengeniDb, "getOrganizationGovernanceStatus").mockResolvedValue({
      accountId: ACCOUNT_ID,
      kind: "team",
      state: "active",
      governanceRevision: 8,
      authoritySubjectId: "user:owner",
      authorizationInvalidatedAt: new Date(Date.now() + 5_000).toISOString(),
    });
    try {
      const response = await lockedRequest("user:old-owner");
      expect(response.status).toBe(401);
      expect(await response.text()).toContain("authorization invalidated by governance recovery");
    } finally {
      status.mockRestore();
    }
  });

  test("requires direct managed-human authentication for a recovery custodian", async () => {
    const subjectId = "user:custodian";
    const accountGrant = {
      accountId: ACCOUNT_ID,
      subjectId,
      permissions: [] as [],
    };
    const delegatedContext: AccessContext = {
      mode: "managed",
      subjectId,
      accountGrants: [{ ...accountGrant, metadata: { delegated: true } }],
      workspaceGrants: [],
      defaultAccountId: ACCOUNT_ID,
      defaultWorkspaceId: null,
    };
    const governance = spyOn(opengeniDb, "getOrganizationGovernance").mockResolvedValue({
      accountId: ACCOUNT_ID,
      kind: "team",
      state: "governance_locked",
      governanceRevision: 7,
      authoritySubjectId: "user:owner",
      recoveryPolicy: {
        revision: 1,
        quorum: 2,
        custodians: [
          {
            subjectId,
            subjectLabel: null,
            policyRevision: 1,
            enrolledAt: new Date().toISOString(),
          },
        ],
      },
      authorizationInvalidatedAt: null,
    });
    const accepted = spyOn(opengeniDb, "isAcceptedOrganizationRecoveryCustodian").mockResolvedValue(
      true,
    );
    try {
      await expect(
        requireOrganizationRecoveryCustodian(deps(), delegatedContext, ACCOUNT_ID),
      ).rejects.toMatchObject({ status: 403 });
      expect(governance).not.toHaveBeenCalled();

      const directContext: AccessContext = {
        ...delegatedContext,
        accountGrants: [{ ...accountGrant, metadata: { authType: "managed" } }],
      };
      recordEvidence(directContext, {
        userId: "custodian",
        sessionId: "direct-session",
      });
      await expect(
        requireOrganizationRecoveryCustodian(deps(), directContext, ACCOUNT_ID),
      ).resolves.toMatchObject({ accountId: ACCOUNT_ID, state: "governance_locked" });

      governance.mockResolvedValue({
        accountId: ACCOUNT_ID,
        kind: "team",
        state: "active",
        governanceRevision: 8,
        authoritySubjectId: subjectId,
        recoveryPolicy: {
          revision: 1,
          quorum: 2,
          custodians: [
            {
              subjectId,
              subjectLabel: null,
              policyRevision: 1,
              enrolledAt: new Date().toISOString(),
            },
          ],
        },
        authorizationInvalidatedAt: new Date().toISOString(),
      });
      await expect(
        requireOrganizationRecoveryCustodian(deps(), directContext, ACCOUNT_ID),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        requireOrganizationRecoveryCustodianOrReplay(deps(), directContext, ACCOUNT_ID),
      ).resolves.toMatchObject({ accountId: ACCOUNT_ID, state: "active" });
      expect(governance).toHaveBeenCalledTimes(3);
    } finally {
      governance.mockRestore();
      accepted.mockRestore();
    }
  });

  test("requires account authority rather than a workspace-admin-shaped account grant", async () => {
    const context: AccessContext = {
      mode: "managed",
      subjectId: "user:workspace-admin",
      accountGrants: [
        {
          accountId: ACCOUNT_ID,
          subjectId: "user:workspace-admin",
          permissions: ["workspace:admin"],
        },
      ],
      workspaceGrants: [],
      defaultAccountId: ACCOUNT_ID,
      defaultWorkspaceId: null,
    };
    const governance = spyOn(opengeniDb, "getOrganizationGovernance").mockResolvedValue(null);
    try {
      await expect(
        requireOrganizationGovernanceAdmin(deps(), context, ACCOUNT_ID),
      ).rejects.toMatchObject({ status: 403 });
      expect(governance).not.toHaveBeenCalled();
    } finally {
      governance.mockRestore();
    }
  });

  test("rejects local and configured governance policy or lock admission before database access", async () => {
    const governance = spyOn(opengeniDb, "getOrganizationGovernance");
    const activeContext = (mode: "local" | "configured"): AccessContext => ({
      mode,
      subjectId: "configured:admin",
      accountGrants: [
        {
          accountId: ACCOUNT_ID,
          subjectId: "configured:admin",
          permissions: ["account:admin"],
        },
      ],
      workspaceGrants: [],
      defaultAccountId: ACCOUNT_ID,
      defaultWorkspaceId: null,
    });
    try {
      for (const mode of ["local", "configured"] as const) {
        const context = activeContext(mode);
        await expect(
          requireOrganizationGovernanceAdmin(deps(), context, ACCOUNT_ID),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          requireOrganizationGovernanceAdminOrLockedReplay(deps(), context, ACCOUNT_ID),
        ).rejects.toMatchObject({ status: 403 });
      }
      expect(governance).not.toHaveBeenCalled();
    } finally {
      governance.mockRestore();
    }
  });
});
