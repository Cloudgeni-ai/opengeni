import { describe, expect, test } from "bun:test";
import { ApiHttpError } from "../src/http/api-error";
import {
  TEAMS_CONNECTION_REFUSED_CODE,
  teamsConnectionRefused,
  teamsLinkConflict,
  type TeamsConnectionRefusal,
} from "../src/integrations/teams-setup-refusals";

const reasons: TeamsConnectionRefusal[] = [
  "state_invalid",
  "state_expired",
  "state_mismatch",
  "consumer_tenant",
  "token_exchange_failed",
  "id_token_invalid",
  "tenant_mismatch",
  "user_mismatch",
  "not_tenant_admin",
  "setup_link_invalid",
  "microsoft_sign_in_required",
  "setup_unavailable",
  "shared_workspace_required",
  "workspace_linked_elsewhere",
  "connected_elsewhere",
  "linked_elsewhere",
  "move_requires_global_admin",
  "already_connected",
  "connection_changed",
  "setup_link_used",
  "opengeni_account_linked",
  "teams_account_linked",
  "link_opengeni_account_linked",
  "link_used",
  "link_changed",
];

describe("Teams setup refusals", () => {
  test("each is an expected, non-retryable refusal marked for the page to show as is", () => {
    for (const reason of reasons) {
      const error = teamsConnectionRefused(reason);
      expect(error).toBeInstanceOf(ApiHttpError);
      expect([400, 403, 409, 422]).toContain(error.status);
      expect(error.retryable).toBe(false);
      expect(error.outcomeUnknown).toBe(false);
      expect(error.details).toEqual({ code: TEAMS_CONNECTION_REFUSED_CODE, reason });
      // A full sentence that fits the public error message bound (512 bytes)
      // and names no code, field or identifier.
      expect(new TextEncoder().encode(error.message).byteLength).toBeLessThanOrEqual(512);
      expect(error.message).toMatch(/^[A-Z].*\.$/u);
      expect(error.message).not.toMatch(/\b[a-z]+_[a-z_]+\b|[0-9a-f]{8}-[0-9a-f]{4}/u);
    }
  });

  test("the non-administrator refusal keeps its full way forward", () => {
    expect(teamsConnectionRefused("not_tenant_admin")).toMatchObject({
      status: 403,
      code: "forbidden",
      message:
        "Only a Microsoft 365 Global Administrator or Teams Administrator can connect your organization. Ask your admin to message Opengeni in Teams and select Connect your organization. If your admin role must be activated first, activate it and try again.",
    });
  });

  test("database link conflicts name the rule, not the other account", () => {
    const unique = (constraint: string) => ({ code: "23505", constraint_name: constraint });
    expect(teamsLinkConflict(unique("teams_bot_proofs_pkey"))).toBe("proof_used");
    expect(teamsLinkConflict(unique("teams_bot_links_workspace_id_subject_id_key"))).toBe(
      "opengeni_account_linked",
    );
    // Drizzle wraps the driver error.
    expect(
      teamsLinkConflict({
        message: "Failed query",
        cause: unique("teams_bot_links_workspace_id_subject_id_key"),
      }),
    ).toBe("opengeni_account_linked");
    // A wrapper with its own non-SQL code still exposes the driver error.
    expect(
      teamsLinkConflict({
        code: "ERR_WRAPPED",
        cause: { message: "Failed query", cause: unique("teams_bot_proofs_pkey") },
      }),
    ).toBe("proof_used");
    expect(teamsLinkConflict(new Error("teams_identity_already_linked"))).toBe(
      "teams_account_linked",
    );
    expect(teamsLinkConflict(unique("some_other_key"))).toBe("other");
    expect(teamsLinkConflict({ code: "40001" })).toBeNull();
    expect(teamsLinkConflict(new Error("boom"))).toBeNull();
    expect(teamsLinkConflict(null)).toBeNull();
  });
});
