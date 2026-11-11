import { z } from "zod";
import { defineSchema } from "./define-schema";

/**
 * The secret history scrub (docs/secrets.md, "Removing secrets from stored
 * history"): `POST /v1/workspaces/:workspaceId/secret-redactions`. A workspace
 * admin chooses sessions and what to look for; every stored copy is replaced
 * by `[redacted: <reference or kind>]`. The response carries counts only,
 * never text from a session or the secret.
 */

export const SECRET_REDACTION_MAX_SESSIONS = 200;
export const SECRET_REDACTION_MAX_HOSTS = 20;

/** A hostname as written in a URL: letters, digits, dots and hyphens. */
const RedactionHost = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/u, "invalid hostname");

export const SecretRedactionPattern = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("kind", [
    z
      .object({
        /** The password part of `scheme://user:password@host` URLs. */
        kind: z.literal("url_password"),
        /** Only URLs with one of these hosts; every host when omitted. */
        hosts: z.array(RedactionHost).min(1).max(SECRET_REDACTION_MAX_HOSTS).optional(),
      })
      .strict(),
    z
      .object({
        /** GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`). */
        kind: z.literal("github_token"),
      })
      .strict(),
  ]),
);
export type SecretRedactionPattern = z.infer<typeof SecretRedactionPattern>;

export const SecretRedactionMatch = /* @__PURE__ */ defineSchema(() =>
  z.union([
    z
      .object({
        /**
         * A vault reference, `Vault/Item/field` or `Item/field`, with or
         * without the surrounding reference braces. Its value is read in
         * memory for matching only and never returned, logged or audited.
         */
        reference: z.string().min(1).max(600),
      })
      .strict(),
    z
      .object({
        patterns: z.array(SecretRedactionPattern).min(1).max(10),
      })
      .strict(),
  ]),
);
export type SecretRedactionMatch = z.infer<typeof SecretRedactionMatch>;

export const SecretRedactionRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      sessionIds: z.array(z.string().uuid()).min(1).max(SECRET_REDACTION_MAX_SESSIONS),
      /** Include every descendant session (children, their children, ...). */
      includeDescendants: z.boolean().default(false),
      match: SecretRedactionMatch,
      /** Count the copies without changing anything. */
      dryRun: z.boolean().default(false),
    })
    .strict(),
);
export type SecretRedactionRequest = z.infer<typeof SecretRedactionRequest>;

export const SecretRedactionCounts = /* @__PURE__ */ defineSchema(() =>
  z.object({
    /** Rows (or archive lines) holding at least one match when read. */
    rowsMatched: z.number().int().nonnegative(),
    /**
     * Rows rewritten or blobs deleted; for an archive, the lines rewritten,
     * added or dropped in the replaced object. 0 in a dry run.
     */
    rowsChanged: z.number().int().nonnegative(),
    /** Matches found when read. */
    matches: z.number().int().nonnegative(),
  }),
);
export type SecretRedactionCounts = z.infer<typeof SecretRedactionCounts>;

export const SecretRedactionResponse = /* @__PURE__ */ defineSchema(() =>
  z.object({
    dryRun: z.boolean(),
    /** What was looked for: the reference as given, or the pattern kinds. Never a value. */
    match: z.object({
      kind: z.enum(["reference", "patterns"]),
      label: z.string(),
    }),
    sessions: z.array(
      z.object({
        sessionId: z.string().uuid(),
        archived: z.boolean(),
        /** Only tables with a match. */
        tables: z.record(z.string(), SecretRedactionCounts),
      }),
    ),
    /** Totals per table across the sessions, every table listed. */
    tables: z.record(z.string(), SecretRedactionCounts),
    /**
     * Places this run could not rewrite yet because the database routines
     * they need are not enabled for the service; run again once they are.
     */
    pending: z.array(z.string()),
    /** Places that failed, by table and error code only. A rerun retries them. */
    failures: z.array(
      z.object({
        sessionId: z.string().uuid().nullable(),
        table: z.string(),
        code: z.string(),
      }),
    ),
  }),
);
export type SecretRedactionResponse = z.infer<typeof SecretRedactionResponse>;
