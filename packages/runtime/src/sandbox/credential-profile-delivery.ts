/**
 * Credential profiles at the exec boundary (docs/secrets.md, "Credential
 * profiles").
 *
 * A profile maps environment variable names to secret references. For every
 * command an agent runs, `forCommand` resolves the effective profile through
 * the attempt's `SecretResolver` (vault policy, per-use approval and audit
 * apply) and returns the variables to add to that command's environment. The
 * values ride the in-memory secret carry (secret-delivery.ts) to the
 * provider call: native `ExecRequest.env` on Connected Machines, the sourced
 * and deleted 0600 env file on managed sandboxes. The command text and every
 * stored argument stay unchanged.
 *
 * Lenient by design: an entry that cannot be resolved is skipped and named
 * in a short note for the tool result. Nothing here ever fails a command.
 */
import {
  isCredentialProfileEnvName,
  isSecretReferenceError,
  referenceKey,
  secretValueAtDispatch,
  tokenizeSecretText,
  type EffectiveCredentialProfile,
  type ResolvedSecretValue,
  type SecretReference,
  type SecretReferenceFailureCode,
  type SecretResolver,
} from "@opengeni/contracts";
import type { SecretExecUse } from "./secret-delivery";

/** Bytes of one profile value, the same cap as one referenced value. */
const PROFILE_VALUE_MAX_BYTES = 102_400;
/** Bytes of all profile values for one command, the same cap as referenced values. */
const PROFILE_TOTAL_MAX_BYTES = 262_144;
/** How long a loaded profile is reused before it is read again. */
const DEFAULT_PROFILE_TTL_MS = 5_000;
/**
 * How long one command waits for the profile read. A slow database must not
 * stall commands: past this, the last profile read successfully (or none)
 * is used and the read finishes in the background.
 */
const DEFAULT_PROFILE_LOAD_TIMEOUT_MS = 2_000;
/** How long one command waits for the password manager to resolve the profile. */
const DEFAULT_PROFILE_RESOLVE_TIMEOUT_MS = 15_000;
/**
 * Failures that stay true for the rest of the attempt: retrying them for
 * every command would only repeat the same refusal (and, for approvals, the
 * person's answer starts a new turn anyway).
 */
const STICKY_FAILURES = new Set<SecretReferenceFailureCode>(["approval_required", "denied"]);

/** The git helper reads this variable when git asks for github.com credentials. */
export const CREDENTIAL_PROFILE_GIT_TOKEN_VARIABLE = "GH_TOKEN";
/**
 * Comma-separated names of the variables a profile delivered to this
 * command. The managed-sandbox provider CLI wrappers (gh, glab, az) read it
 * and keep a profile-supplied token instead of replacing it with the
 * platform's repository binding. Profiles cannot set `OPENGENI_` names, so
 * only Opengeni writes it.
 */
export const CREDENTIAL_PROFILE_VARS_VARIABLE = "OPENGENI_CREDENTIAL_PROFILE_VARS";
const GIT_HELPER_KEY = "credential.https://github.com.helper";
/**
 * A credential helper that answers `get` with GH_TOKEN from the process
 * environment. Git runs `!` helpers through its shell (Git for Windows ships
 * one), so the token is read at use time and never written into config,
 * files or the command line. It answers nothing when GH_TOKEN is empty.
 */
export const CREDENTIAL_PROFILE_GIT_HELPER =
  '!f() { test "$1" = get || return 0; test -n "$GH_TOKEN" || return 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

export type CredentialEnvironmentResult = {
  /**
   * Variables to add to the command's environment. They have the lowest
   * precedence: anything the command sets itself wins.
   */
  env: Record<string, string>;
  /** Short, metadata-only notes for the tool result (never values). */
  notes: string[];
};

export interface CredentialEnvironment {
  /** The profile variables for one command. Never throws. */
  forCommand(use: SecretExecUse): Promise<CredentialEnvironmentResult>;
}

export type CreateCredentialEnvironmentInput = {
  /** The attempt's resolver; profiles are not applied without an enabled one. */
  resolver: SecretResolver | null | undefined;
  /** Loads the effective profile of the attempt's session (null: none). */
  load: () => Promise<EffectiveCredentialProfile | null>;
  /**
   * Part B hook: every profile value delivered to a command, so the
   * attempt's known-secret masking also covers values that never appeared
   * as a reference. Called before the command is dispatched.
   */
  onValuesDelivered?: (values: readonly string[]) => void;
  profileTtlMs?: number;
  loadTimeoutMs?: number;
  resolveTimeoutMs?: number;
  now?: () => number;
};

class ProfileTimeoutError extends Error {}

/** Settle with `promise`, or reject with ProfileTimeoutError after `ms`. */
async function withinTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProfileTimeoutError()), ms);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const NOTHING: CredentialEnvironmentResult = { env: {}, notes: [] };

function describeFailure(code: string): string {
  switch (code) {
    case "not_found":
      return "secret not found";
    case "ambiguous":
      return "reference matches more than one secret";
    case "denied":
      return "not allowed";
    case "approval_required":
      return "waiting for the person's approval";
    case "invalid_reference":
      return "invalid reference";
    case "too_large":
      return "value too large";
    case "binary_value":
      return "value is binary";
    case "provider_unavailable":
    case "provider_rate_limited":
    case "provider_auth_expired":
      return "password manager unavailable";
    default:
      return code.replaceAll("_", " ");
  }
}

/** Exactly one plain secret reference (not a secretfile one), or null. */
function profileReference(raw: string): SecretReference | null {
  const tokens = tokenizeSecretText(raw.trim());
  if (tokens.length !== 1) return null;
  const [token] = tokens;
  if (token?.type !== "reference" || token.reference.kind !== "secret") return null;
  return token.reference;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * The per-command git configuration for the built-in helper, appended after
 * any `GIT_CONFIG_*` entries the profile itself sets. The empty value first
 * clears helpers from the machine's own git config for github.com, so git
 * uses the profile token rather than a stale stored one.
 */
export function credentialProfileGitHelperEnvironment(
  existing: Readonly<Record<string, string>>,
): Record<string, string> {
  const parsed = Number.parseInt(existing.GIT_CONFIG_COUNT ?? "0", 10);
  const base = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  return {
    GIT_CONFIG_COUNT: String(base + 2),
    [`GIT_CONFIG_KEY_${base}`]: GIT_HELPER_KEY,
    [`GIT_CONFIG_VALUE_${base}`]: "",
    [`GIT_CONFIG_KEY_${base + 1}`]: GIT_HELPER_KEY,
    [`GIT_CONFIG_VALUE_${base + 1}`]: CREDENTIAL_PROFILE_GIT_HELPER,
  };
}

type PreparedEntry = { name: string; reference: SecretReference };

export function createCredentialEnvironment(
  input: CreateCredentialEnvironmentInput,
): CredentialEnvironment {
  const ttl = input.profileTtlMs ?? DEFAULT_PROFILE_TTL_MS;
  const loadTimeout = input.loadTimeoutMs ?? DEFAULT_PROFILE_LOAD_TIMEOUT_MS;
  const resolveTimeout = input.resolveTimeoutMs ?? DEFAULT_PROFILE_RESOLVE_TIMEOUT_MS;
  const now = input.now ?? Date.now;
  let cached: { at: number; profile: Promise<EffectiveCredentialProfile | null> } | null = null;
  /** The last profile read successfully in this attempt (null: none set). */
  let lastGood: EffectiveCredentialProfile | null = null;
  const sticky = new Map<string, string>();
  /** Notes already shown in this attempt: each one is shown once. */
  const shown = new Set<string>();

  function loadProfile(): Promise<EffectiveCredentialProfile | null> {
    const at = now();
    if (!cached || at - cached.at >= ttl) {
      const profile = Promise.resolve().then(() => input.load());
      cached = { at, profile };
      profile.then(
        (value) => {
          lastGood = value;
        },
        () => {
          // A failed read is not reused.
          if (cached?.profile === profile) cached = null;
        },
      );
    }
    return cached.profile;
  }

  /**
   * The effective profile, never waiting longer than the load timeout. A
   * slow or failed read falls back to the last good profile, silently: a
   * workspace that never set a profile sees no difference at all.
   */
  async function currentProfile(): Promise<EffectiveCredentialProfile | null> {
    try {
      return await withinTimeout(loadProfile(), loadTimeout);
    } catch {
      return lastGood;
    }
  }

  function unseen(items: readonly string[]): string[] {
    const fresh = items.filter((item) => !shown.has(item));
    for (const item of fresh) shown.add(item);
    return fresh;
  }

  async function resolveLeniently(
    resolver: SecretResolver,
    entries: readonly PreparedEntry[],
    use: SecretExecUse,
    skipped: Map<string, string>,
  ): Promise<Map<string, ResolvedSecretValue>> {
    const resolved = new Map<string, ResolvedSecretValue>();
    let pending = [...entries];
    // Each failed batch removes at least one reference, so this ends. A
    // reference that failed is never asked for again in this command (a
    // second approval request would post a second card).
    while (pending.length > 0) {
      const refs = new Map<string, SecretReference>();
      for (const entry of pending) refs.set(referenceKey(entry.reference), entry.reference);
      try {
        const values = await withinTimeout(
          resolver.resolve([...refs.values()], {
            surface: use.surface,
            toolName: use.toolName,
            ...(use.sourceCallId ? { sourceCallId: use.sourceCallId } : {}),
            ...(use.destination ? { destination: use.destination } : {}),
          }),
          resolveTimeout,
        );
        for (const [key, value] of values) resolved.set(key, value);
        return resolved;
      } catch (error) {
        if (!isSecretReferenceError(error)) {
          const why =
            error instanceof ProfileTimeoutError
              ? "password manager did not answer in time"
              : "could not be resolved";
          for (const entry of pending) skipped.set(entry.name, why);
          return resolved;
        }
        const failedRaw = new Map(error.failures.map((failure) => [failure.raw, failure.code]));
        const failedKeys = new Set<string>();
        for (const entry of pending) {
          const code = failedRaw.get(entry.reference.raw);
          if (code === undefined) continue;
          const key = referenceKey(entry.reference);
          failedKeys.add(key);
          if (STICKY_FAILURES.has(code)) sticky.set(key, code);
        }
        if (failedKeys.size === 0) {
          // The failure named nothing we sent: give up on this batch.
          for (const entry of pending) skipped.set(entry.name, "could not be resolved");
          return resolved;
        }
        for (const entry of pending) {
          const code = failedRaw.get(entry.reference.raw);
          if (code !== undefined) skipped.set(entry.name, describeFailure(code));
        }
        pending = pending.filter((entry) => !failedKeys.has(referenceKey(entry.reference)));
      }
    }
    return resolved;
  }

  async function forCommand(use: SecretExecUse): Promise<CredentialEnvironmentResult> {
    const profile = await currentProfile();
    if (!profile || (profile.entries.length === 0 && !profile.gitHelper)) return NOTHING;
    const resolver = input.resolver;
    // An agent with secrets turned off simply runs without the profile; a
    // note on every one of its commands would only be noise.
    if (!resolver?.enabled) return NOTHING;
    const skipped = new Map<string, string>();
    const entries: PreparedEntry[] = [];
    for (const entry of profile.entries) {
      if (!isCredentialProfileEnvName(entry.name)) {
        skipped.set(entry.name, "invalid variable name");
        continue;
      }
      const reference = profileReference(entry.reference);
      if (!reference) {
        skipped.set(entry.name, "invalid reference");
        continue;
      }
      const stuck = sticky.get(referenceKey(reference));
      if (stuck !== undefined) {
        skipped.set(entry.name, describeFailure(stuck));
        continue;
      }
      entries.push({ name: entry.name, reference });
    }
    const env: Record<string, string> = {};
    const delivered: string[] = [];
    try {
      const values =
        entries.length > 0 ? await resolveLeniently(resolver, entries, use, skipped) : new Map();
      let total = 0;
      for (const entry of entries) {
        const value = values.get(referenceKey(entry.reference));
        if (!value) continue;
        const material = await secretValueAtDispatch(value);
        if (typeof material !== "string" || material.includes("\u0000")) {
          skipped.set(entry.name, describeFailure("binary_value"));
          continue;
        }
        const length = utf8Length(material);
        if (length > PROFILE_VALUE_MAX_BYTES || total + length > PROFILE_TOTAL_MAX_BYTES) {
          skipped.set(entry.name, describeFailure("too_large"));
          continue;
        }
        total += length;
        env[entry.name] = material;
        delivered.push(material);
      }
    } catch {
      for (const entry of entries) {
        if (!(entry.name in env)) skipped.set(entry.name, "could not be resolved");
      }
    }
    const notes: string[] = [];
    const skippedNow = unseen([...skipped].map(([name, why]) => `${name} (${why})`));
    if (skippedNow.length > 0) notes.push(`credential profile skipped ${skippedNow.join(", ")}`);
    if (profile.gitHelper) {
      if (env[CREDENTIAL_PROFILE_GIT_TOKEN_VARIABLE]) {
        Object.assign(env, credentialProfileGitHelperEnvironment(env));
      } else {
        notes.push(
          ...unseen([
            `credential profile git helper not applied: ${CREDENTIAL_PROFILE_GIT_TOKEN_VARIABLE} is not set`,
          ]),
        );
      }
    }
    if (delivered.length > 0) {
      env[CREDENTIAL_PROFILE_VARS_VARIABLE] = Object.keys(env).join(",");
    }
    if (delivered.length > 0) {
      try {
        input.onValuesDelivered?.(delivered);
      } catch {
        // A masking hook must never fail the command.
      }
    }
    return { env, notes };
  }

  return {
    async forCommand(use) {
      try {
        return await forCommand(use);
      } catch {
        return {
          env: {},
          notes: unseen(["credential profile could not be applied; ran without it"]),
        };
      }
    },
  };
}

/** One line for the end of a tool result, or null when there is nothing to say. */
export function credentialProfileNoteText(notes: readonly string[] | undefined): string | null {
  if (!notes || notes.length === 0) return null;
  return `[Note: ${notes.join("; ")}]`;
}

/**
 * Append the notes to a command result. Strings get a trailing line; a
 * structured result gets it on its `output` text when it has one. Anything
 * else is returned unchanged.
 */
export function withCredentialProfileNotes<T>(output: T, notes: readonly string[] | undefined): T {
  const text = credentialProfileNoteText(notes);
  if (text === null) return output;
  if (typeof output === "string") {
    return `${output}${output.endsWith("\n") || output.length === 0 ? "" : "\n"}${text}` as T;
  }
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const value = output as Record<string, unknown>;
    if (typeof value.output === "string") {
      const current = value.output;
      return {
        ...value,
        output: `${current}${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${text}`,
      } as T;
    }
  }
  return output;
}
