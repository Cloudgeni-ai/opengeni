import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
/**
 * Credential profiles: an opt-in mapping from environment variable names to
 * secret references that Opengeni puts into the environment of every command
 * an agent runs (exec_command, background commands, `run_on` exec), so CLIs
 * such as `gh`, `git` and `az` find their credentials without the agent
 * writing references into each command or a child's prompt.
 *
 * A workspace has at most one profile; a session can add its own entries,
 * which its child sessions inherit (nearest session wins for a name). The
 * references are resolved per command through the attempt's secret resolver,
 * so vault policy, per-use approval and audit apply. Values exist only in
 * the command's process environment, never on disk or in stored text.
 *
 * This module must not import runtime values from `./index` (the index
 * re-exports it); only types cross that edge.
 */
import { z } from "zod";

export const CREDENTIAL_PROFILE_LIMITS = {
  entriesMax: 32,
  nameMaxChars: 128,
  referenceMaxChars: 300,
} as const;

/**
 * Names reserved for Opengeni itself (per-command secret bindings, the
 * Codemode bearer and similar). A profile cannot set them.
 */
export const CREDENTIAL_PROFILE_RESERVED_PREFIX = "OPENGENI_";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True for a portable environment variable name a profile may set. */
export function isCredentialProfileEnvName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= CREDENTIAL_PROFILE_LIMITS.nameMaxChars &&
    ENV_NAME_PATTERN.test(name) &&
    !name.toUpperCase().startsWith(CREDENTIAL_PROFILE_RESERVED_PREFIX)
  );
}

/**
 * Accept a reference written escaped (a leading backslash), as agents are
 * taught to write references they hand on, and store it unescaped. Profile
 * tools never resolve references, so both forms mean the same reference.
 */
export function normalizeCredentialProfileReference(reference: string): string {
  const trimmed = reference.trim();
  return trimmed.startsWith("\\{{") ? trimmed.slice(1) : trimmed;
}

export const CredentialProfileEntry = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** Environment variable name, for example `GH_TOKEN`. */
      name: primitives.string.min(1).max(CREDENTIAL_PROFILE_LIMITS.nameMaxChars),
      /** One secret reference, for example `{{secret:Vault/Item/field}}`. */
      reference: primitives.string.min(1).max(CREDENTIAL_PROFILE_LIMITS.referenceMaxChars + 1),
    })
    .strict(),
);
export type CredentialProfileEntry = z.infer<typeof CredentialProfileEntry>;

/** The body of a profile at one level (workspace or session). */
export const CredentialProfileInput = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      entries: z.array(CredentialProfileEntry).max(CREDENTIAL_PROFILE_LIMITS.entriesMax),
      /**
       * Built-in git helper: git commands use `GH_TOKEN` for github.com over
       * HTTPS through per-command `GIT_CONFIG_*` variables. `null` on a
       * session inherits; on the workspace it means off.
       */
      gitHelper: primitives.boolean.nullable().optional(),
    })
    .strict(),
);
export type CredentialProfileInput = z.infer<typeof CredentialProfileInput>;

export const CredentialProfileScope = /* @__PURE__ */ defineSchema(() =>
  z.enum(["workspace", "session"]),
);
export type CredentialProfileScope = z.infer<typeof CredentialProfileScope>;

export const CredentialProfileView = /* @__PURE__ */ defineSchema(() =>
  z.object({
    scope: CredentialProfileScope,
    /** Set for a session profile. */
    sessionId: primitives.nullableUuid,
    entries: z.array(CredentialProfileEntry),
    gitHelper: primitives.boolean.nullable(),
    updatedAt: primitives.string,
    updatedBySubjectId: primitives.string,
  }),
);
export type CredentialProfileView = z.infer<typeof CredentialProfileView>;

export const EffectiveCredentialProfileEntry = /* @__PURE__ */ defineSchema(() =>
  CredentialProfileEntry.extend({
    /** Where the entry comes from: the workspace, or the session (this one or an ancestor) that set it. */
    source: z.object({ scope: CredentialProfileScope, sessionId: primitives.nullableUuid }),
  }),
);
export type EffectiveCredentialProfileEntry = z.infer<typeof EffectiveCredentialProfileEntry>;

/** What a session's commands receive: workspace entries, then each session from the root down. */
export const EffectiveCredentialProfile = /* @__PURE__ */ defineSchema(() =>
  z.object({
    entries: z.array(EffectiveCredentialProfileEntry),
    gitHelper: primitives.boolean,
  }),
);
export type EffectiveCredentialProfile = z.infer<typeof EffectiveCredentialProfile>;

export const WorkspaceCredentialProfileResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({ profile: CredentialProfileView.nullable() }),
);
export type WorkspaceCredentialProfileResponse = z.infer<typeof WorkspaceCredentialProfileResponse>;

export const SessionCredentialProfileResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** The session's own addition; null when it adds nothing. */
    profile: CredentialProfileView.nullable(),
    effective: EffectiveCredentialProfile,
  }),
);
export type SessionCredentialProfileResponse = z.infer<typeof SessionCredentialProfileResponse>;

// ---------------------------------------------------------------------------
// Agent tools (capability `secrets`). Named `secret_*` so the tool gateway
// hands them references as written and never resolves them.
// ---------------------------------------------------------------------------

export const CREDENTIAL_PROFILE_TOOL_NAMES = ["secret_profile_get", "secret_profile_set"] as const;
export type CredentialProfileToolName = (typeof CREDENTIAL_PROFILE_TOOL_NAMES)[number];

export const SecretProfileGetInput = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** `session` (default): this session's addition and what its commands receive. `workspace`: the workspace profile. */
      scope: CredentialProfileScope.optional(),
    })
    .strict(),
);
export type SecretProfileGetInput = z.infer<typeof SecretProfileGetInput>;

export const SecretProfileSetInput = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** `session` (default): this session and the child sessions it starts. `workspace`: every session in the workspace. */
      scope: CredentialProfileScope.optional(),
      /** Replaces the whole profile at that level. An empty list with no git helper clears it. */
      entries: z.array(CredentialProfileEntry).max(CREDENTIAL_PROFILE_LIMITS.entriesMax),
      gitHelper: primitives.boolean.nullable().optional(),
    })
    .strict(),
);
export type SecretProfileSetInput = z.infer<typeof SecretProfileSetInput>;
