/**
 * Credential profiles (docs/secrets.md, "Credential profiles"): the workspace
 * profile and per-session additions, their validation, the effective profile
 * a session's commands receive, and the attempt's per-command environment.
 *
 * Profiles hold names and references only. Values are resolved per command
 * through the attempt's secret resolver (vault policy, per-use approval and
 * audit apply) and exist only in that command's environment.
 */
import {
  CREDENTIAL_PROFILE_LIMITS,
  CREDENTIAL_PROFILE_RESERVED_PREFIX,
  isCredentialProfileEnvName,
  normalizeCredentialProfileReference,
  tokenizeSecretText,
  type CredentialProfileEntry,
  type CredentialProfileInput,
  type CredentialProfileView,
  type EffectiveCredentialProfile,
  type SecretResolver,
  type SessionCredentialProfileResponse,
  type WorkspaceCredentialProfileResponse,
} from "@opengeni/contracts";
import {
  CredentialProfileSessionNotFoundError,
  getCredentialProfile,
  listCredentialProfileChain,
  recordAuditEvent,
  saveCredentialProfile,
  type CredentialProfileChainLink,
  type CredentialProfileRow,
  type Database,
} from "@opengeni/db";
import { createCredentialEnvironment, type CredentialEnvironment } from "@opengeni/runtime/sandbox";

export type CredentialProfileErrorCode =
  | "credential_profile_invalid"
  | "credential_profile_session_not_found";

export class CredentialProfileError extends Error {
  constructor(
    readonly code: CredentialProfileErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CredentialProfileError";
  }

  get status(): 404 | 422 {
    return this.code === "credential_profile_session_not_found" ? 404 : 422;
  }
}

export function isCredentialProfileError(error: unknown): error is CredentialProfileError {
  return error instanceof CredentialProfileError;
}

export type ValidCredentialProfile = {
  entries: CredentialProfileEntry[];
  gitHelper: boolean | null;
};

/**
 * Check a profile before it is saved: portable, unreserved, distinct names
 * and exactly one plain secret reference per entry (an escaped reference is
 * accepted and stored unescaped). Every problem is reported at once.
 */
export function validateCredentialProfileInput(
  input: CredentialProfileInput,
): ValidCredentialProfile {
  const issues: Array<{ index: number; name: string; problem: string }> = [];
  const seen = new Set<string>();
  const entries: CredentialProfileEntry[] = [];
  if (input.entries.length > CREDENTIAL_PROFILE_LIMITS.entriesMax) {
    throw new CredentialProfileError(
      "credential_profile_invalid",
      `a profile has at most ${CREDENTIAL_PROFILE_LIMITS.entriesMax} variables`,
    );
  }
  input.entries.forEach((entry, index) => {
    const name = entry.name.trim();
    if (!isCredentialProfileEnvName(name)) {
      issues.push({
        index,
        name,
        problem: name.toUpperCase().startsWith(CREDENTIAL_PROFILE_RESERVED_PREFIX)
          ? `names starting with ${CREDENTIAL_PROFILE_RESERVED_PREFIX} are reserved for Opengeni`
          : "use letters, digits and underscores, not starting with a digit",
      });
    } else if (seen.has(name.toUpperCase())) {
      issues.push({ index, name, problem: "this variable is listed twice" });
    }
    seen.add(name.toUpperCase());
    const reference = normalizeCredentialProfileReference(entry.reference);
    const tokens = tokenizeSecretText(reference);
    const token = tokens.length === 1 ? tokens[0] : undefined;
    if (
      reference.length > CREDENTIAL_PROFILE_LIMITS.referenceMaxChars ||
      token?.type !== "reference" ||
      token.reference.kind !== "secret"
    ) {
      issues.push({
        index,
        name,
        problem:
          token?.type === "reference" && token.reference.kind === "secretfile"
            ? "secretfile references are not supported; profile values stay in the environment"
            : "give exactly one secret reference such as {{secret:Vault/Item/field}}",
      });
    }
    entries.push({ name, reference });
  });
  if (issues.length > 0) {
    throw new CredentialProfileError(
      "credential_profile_invalid",
      issues
        .map((issue) => `${issue.name || `entry ${issue.index + 1}`}: ${issue.problem}`)
        .join("; "),
      { issues },
    );
  }
  return { entries, gitHelper: input.gitHelper ?? null };
}

export function credentialProfileView(row: CredentialProfileRow): CredentialProfileView {
  return {
    scope: row.sessionId === null ? "workspace" : "session",
    sessionId: row.sessionId,
    entries: row.entries.map((entry) => ({ name: entry.name, reference: entry.reference })),
    gitHelper: row.gitHelper,
    updatedAt: row.updatedAt.toISOString(),
    updatedBySubjectId: row.updatedBySubjectId,
  };
}

/**
 * Merge a profile chain (workspace first, then sessions from the root down):
 * a nearer level replaces an entry of the same name (compared without case,
 * as validation does, so Windows never sees two spellings of one variable),
 * and the nearest non-null git helper setting wins (off when none sets it).
 */
export function effectiveCredentialProfile(
  chain: readonly CredentialProfileChainLink[],
): EffectiveCredentialProfile {
  const entries = new Map<string, EffectiveCredentialProfile["entries"][number]>();
  let gitHelper = false;
  for (const link of chain) {
    for (const entry of link.entries) {
      if (typeof entry?.name !== "string" || typeof entry.reference !== "string") continue;
      const key = entry.name.toUpperCase();
      entries.delete(key);
      entries.set(key, {
        name: entry.name,
        reference: entry.reference,
        source: {
          scope: link.sessionId === null ? "workspace" : "session",
          sessionId: link.sessionId,
        },
      });
    }
    if (link.gitHelper !== null) gitHelper = link.gitHelper;
  }
  return { entries: [...entries.values()], gitHelper };
}

export async function loadEffectiveCredentialProfile(
  db: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<EffectiveCredentialProfile> {
  return effectiveCredentialProfile(await listCredentialProfileChain(db, input));
}

export async function getWorkspaceCredentialProfile(
  db: Database,
  input: { workspaceId: string },
): Promise<WorkspaceCredentialProfileResponse> {
  const row = await getCredentialProfile(db, { workspaceId: input.workspaceId, sessionId: null });
  return { profile: row ? credentialProfileView(row) : null };
}

export async function getSessionCredentialProfile(
  db: Database,
  input: { workspaceId: string; sessionId: string },
): Promise<SessionCredentialProfileResponse> {
  const [row, effective] = await Promise.all([
    getCredentialProfile(db, input),
    loadEffectiveCredentialProfile(db, input),
  ]);
  return { profile: row ? credentialProfileView(row) : null, effective };
}

export type SetCredentialProfileInput = {
  accountId: string;
  workspaceId: string;
  /** NULL: the workspace profile. */
  sessionId: string | null;
  subjectId: string;
  profile: CredentialProfileInput;
  /** The chat whose agent changes it, when an agent does. */
  updatedBySessionId?: string | null;
};

/**
 * Replace one level's profile (authorization is the caller's). An empty
 * profile clears it. Audited with names only, never references or values.
 */
export async function setCredentialProfile(
  db: Database,
  input: SetCredentialProfileInput,
): Promise<CredentialProfileView | null> {
  const valid = validateCredentialProfileInput(input.profile);
  let row: CredentialProfileRow | null;
  try {
    row = await saveCredentialProfile(db, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      entries: valid.entries,
      gitHelper: valid.gitHelper,
      subjectId: input.subjectId,
      updatedBySessionId: input.updatedBySessionId ?? null,
    });
  } catch (error) {
    if (error instanceof CredentialProfileSessionNotFoundError) {
      throw new CredentialProfileError(
        "credential_profile_session_not_found",
        "session not found",
        {
          sessionId: error.sessionId,
        },
      );
    }
    throw error;
  }
  await recordAuditEvent(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    action: row ? "credential_profile.updated" : "credential_profile.cleared",
    targetType: input.sessionId === null ? "workspace" : "session",
    targetId: input.sessionId ?? input.workspaceId,
    metadata: {
      names: valid.entries.map((entry) => entry.name),
      gitHelper: valid.gitHelper,
      ...(input.updatedBySessionId ? { bySessionId: input.updatedBySessionId } : {}),
    },
  }).catch(() => undefined);
  return row ? credentialProfileView(row) : null;
}

/**
 * The per-command credential environment of one attempt: the session's
 * effective profile, read again at most every few seconds, resolved through
 * the attempt's resolver for every command. Never fails a command.
 */
export function createSessionCredentialEnvironment(input: {
  db: Database;
  workspaceId: string;
  sessionId: string;
  resolver: SecretResolver | null | undefined;
  /** Part B hook (known-value masking); see createCredentialEnvironment. */
  onValuesDelivered?: (values: readonly string[]) => void;
}): CredentialEnvironment {
  return createCredentialEnvironment({
    resolver: input.resolver,
    load: () =>
      loadEffectiveCredentialProfile(input.db, {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      }),
    ...(input.onValuesDelivered ? { onValuesDelivered: input.onValuesDelivered } : {}),
  });
}
