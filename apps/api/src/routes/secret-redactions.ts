import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import {
  parseSecretReference,
  SecretRedactionRequest,
  SecretRedactionResponse,
  type AccessGrant,
  type SecretRedactionMatch,
} from "@opengeni/contracts";
import {
  createSecretResolver,
  hasPermission,
  requireWorkspaceSettingsGrant,
  requireSessionAuthorizations,
  runSessionSecretRedaction,
  secretRedactionMatchersForPatterns,
  secretRedactionMatcherForValue,
  secretRedactionReferenceLabel,
  SessionAuthorizationUnavailableError,
  withResolvedSessionAuthorization,
  type ApiRouteDeps,
  type ResolvedSessionAuthorization,
} from "@opengeni/core";
import {
  listSessionsForSecretRedaction,
  recordAuditEvent,
  SESSION_SECRET_REDACTION_MAX_SESSIONS,
  SessionSecretRedactionTooManySessionsError,
  type SecretRedactionMatcher,
  type SessionSecretRedactionReport,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { requireFullAccessIfAgent } from "../http/acting-person";
import { requireSameOriginBrowserMutation } from "../http/browser-mutation-origin";
import { parseRequestBody } from "../http/request-body";
import { workspaceGatewaySecretPrincipal } from "../workspace-tool-gateway-secrets";
import { vaultProviderRegistryFor } from "./vault-providers";

/* ----------------------------------------------------------------------------
   Remove secrets from stored session history (docs/secrets.md, "Removing
   secrets from stored history").

   A workspace owner or admin names sessions and what to look for: a vault
   reference (its value is read in memory for matching and never returned,
   logged or audited; this also needs `secrets:use` on the item) or built-in
   patterns. Every stored copy in those sessions, and in their archives, is
   replaced by `[redacted: <reference or kind>]`. The response and the audit
   event carry counts only. Running it again finds nothing more to change.
   -------------------------------------------------------------------------- */

const REFERENCE_OPEN = "{{secret:";

function sessionNotFound(): never {
  throw new HTTPException(404, { message: "Session not found" });
}

async function authorizeSessions(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionIds: readonly string[],
): Promise<ResolvedSessionAuthorization | null> {
  if (sessionIds.length === 0) return null;
  let decisions;
  try {
    decisions = await requireSessionAuthorizations(deps, grant, {
      sessionIds,
      operation: "session.retention.write",
      surface: "http",
    });
  } catch (error) {
    if (error instanceof SessionAuthorizationUnavailableError) {
      throw new HTTPException(503, { message: "session authorization is unavailable" });
    }
    throw error;
  }
  let first: ResolvedSessionAuthorization | null = null;
  for (const decision of decisions) {
    if (decision.status === "rejected") {
      if (decision.reason instanceof SessionAuthorizationUnavailableError) {
        throw new HTTPException(503, { message: "session authorization is unavailable" });
      }
      sessionNotFound();
    }
    first ??= decision.value;
  }
  return first;
}

/** The reference with its braces, from any written form (braced, `secret:` prefixed, or `Item/field`). */
function referenceText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{{")) return trimmed;
  if (/^secret(?:file)?:/u.test(trimmed)) return `{{${trimmed}}}`;
  return `${REFERENCE_OPEN}${trimmed}}}`;
}

/**
 * Matching a reference reads its value, so it needs permission to use secrets.
 * Workspace admin implies it, except in a grant with explicit permissions.
 */
export function secretRedactionReferenceAllowed(
  grant: Pick<AccessGrant, "permissions" | "permissionMode">,
): boolean {
  return hasPermission(grant.permissions, "secrets:use", grant.permissionMode);
}

async function matchersFor(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  match: SecretRedactionMatch,
): Promise<{ matchers: SecretRedactionMatcher[]; kind: "reference" | "patterns"; label: string }> {
  if ("patterns" in match) {
    return {
      matchers: secretRedactionMatchersForPatterns(match.patterns),
      kind: "patterns",
      label: [...new Set(match.patterns.map((pattern) => pattern.kind))].join(", "),
    };
  }
  if (!secretRedactionReferenceAllowed(grant)) {
    throw new HTTPException(403, {
      message: "Matching a vault reference needs permission to use secrets (secrets:use)",
    });
  }
  let reference;
  try {
    reference = parseSecretReference(referenceText(match.reference));
  } catch {
    // Never echo the input: it could be a value pasted by mistake.
    throw new HTTPException(422, { message: "match.reference is not a valid vault reference" });
  }
  const label = secretRedactionReferenceLabel(reference);
  const resolver = createSecretResolver(
    {
      db: deps.db,
      encryptionKey: environmentsEncryptionKeyBytes(deps.settings) ?? null,
      providers: vaultProviderRegistryFor(deps, {
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
      }),
    },
    workspaceGatewaySecretPrincipal(grant, null),
    { capabilityEnabled: true },
  );
  let value: string;
  try {
    const values = await resolver.resolve([reference], {
      surface: "human_reveal",
      toolName: "secret_redaction",
    });
    const resolved = [...values.values()][0];
    if (!resolved || resolved.material.type === "totp") throw new Error("unsupported");
    value =
      resolved.material.type === "text"
        ? resolved.material.value
        : Buffer.from(resolved.material.value).toString("utf8");
  } catch {
    // The resolver's own message may name candidates; say only what failed.
    throw new HTTPException(404, {
      message: "The reference did not resolve to a text value you can use",
    });
  }
  const matcher = secretRedactionMatcherForValue(value, label);
  if (!matcher) {
    throw new HTTPException(422, {
      message: "The secret's value is too short, or not distinctive enough, to search for safely",
    });
  }
  return { matchers: [matcher], kind: "reference", label };
}

export function registerSecretRedactionRoutes(app: Hono, deps: ApiRouteDeps): void {
  app.post("/v1/workspaces/:workspaceId/secret-redactions", async (c) => {
    c.header("cache-control", "private, no-store");
    requireFullAccessIfAgent(c, "Removing secrets from stored history");
    // Bearer callers carry no ambient browser credentials; cookie sessions must be same-origin.
    if (!c.req.header("authorization")) requireSameOriginBrowserMutation(c, deps);
    const workspaceId = c.req.param("workspaceId");
    // Workspace admins, and the owner of a Personal workspace.
    const grant = await requireWorkspaceSettingsGrant(c, deps, workspaceId);
    const request = parseRequestBody(SecretRedactionRequest, await c.req.json().catch(() => null), {
      status: 422,
      message: "invalid secret redaction request",
    });
    const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };

    const roots = [...new Set(request.sessionIds)];
    const rootAuthorization = await authorizeSessions(deps, grant, roots);
    const within = <T>(fn: () => Promise<T>) =>
      rootAuthorization ? withResolvedSessionAuthorization(rootAuthorization, fn) : fn();
    let sessions;
    try {
      sessions = await within(() =>
        listSessionsForSecretRedaction(deps.db, scope, {
          sessionIds: roots,
          includeDescendants: request.includeDescendants,
          limit: SESSION_SECRET_REDACTION_MAX_SESSIONS,
        }),
      );
    } catch (error) {
      if (error instanceof SessionSecretRedactionTooManySessionsError) {
        throw new HTTPException(422, { message: error.message });
      }
      throw error;
    }
    const listed = new Set(sessions.map((session) => session.id));
    if (roots.some((id) => !listed.has(id))) sessionNotFound();
    await authorizeSessions(
      deps,
      grant,
      sessions.map((session) => session.id).filter((id) => !roots.includes(id)),
    );

    const { matchers, kind, label } = await matchersFor(deps, grant, request.match);
    const audit = async (report: SessionSecretRedactionReport | null) => {
      const totals = Object.values(report?.tables ?? {}).reduce(
        (sum, counts) => ({
          rowsMatched: sum.rowsMatched + counts.rowsMatched,
          rowsChanged: sum.rowsChanged + counts.rowsChanged,
          matches: sum.matches + counts.matches,
        }),
        { rowsMatched: 0, rowsChanged: 0, matches: 0 },
      );
      await recordAuditEvent(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        action: request.dryRun
          ? "session.secret_history.counted"
          : "session.secret_history.redacted",
        targetType: "workspace",
        targetId: grant.workspaceId,
        metadata: {
          // A run that stopped part way is audited too: it may have changed rows.
          outcome: report ? "completed" : "failed",
          matchKind: kind,
          // A reference names the item, never its value; pattern kinds are fixed words.
          match: label,
          dryRun: request.dryRun,
          includeDescendants: request.includeDescendants,
          sessionIds: sessions.map((session) => session.id),
          ...totals,
          pending: report?.pending ?? [],
          failures: report?.failures.length ?? 0,
        },
      });
    };
    let report: SessionSecretRedactionReport;
    try {
      report = await within(() =>
        runSessionSecretRedaction(deps.db, scope, {
          sessionIds: sessions.map((session) => session.id),
          matchers,
          dryRun: request.dryRun,
          storage: deps.objectStorage ?? null,
        }),
      );
    } catch (error) {
      await audit(null).catch(() => undefined);
      throw error;
    }
    // The run happened; a failed audit write must not hide its result.
    await audit(report).catch((error: unknown) => {
      console.warn("[api] secret redaction audit write failed", {
        code:
          typeof (error as { code?: unknown } | null)?.code === "string"
            ? (error as { code: string }).code
            : "unknown",
      });
    });

    return c.json(
      SecretRedactionResponse.parse({
        dryRun: report.dryRun,
        match: { kind, label },
        sessions: report.sessions,
        tables: report.tables,
        pending: report.pending,
        failures: report.failures,
      }),
    );
  });
}
