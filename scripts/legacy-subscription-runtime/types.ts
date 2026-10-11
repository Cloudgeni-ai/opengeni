/**
 * One retired provider runtime for `check:no-legacy-subscription-runtime`.
 *
 * Each provider's legacy decision state (factory tables, retired routines,
 * synthetic subjects, v1 readers) is listed in its own file in this
 * directory and registered in `index.ts`. The engine in
 * `scripts/check-no-legacy-subscription-runtime.ts` is provider-neutral: it
 * names no provider and applies every registered entry to every runtime
 * source file. A provider retired later (Claude, C4) or a retirement step
 * that drops shared routines (R) adds an entry; it never edits the engine.
 */
export type LegacyRuntimeException = {
  /**
   * Exact top-level declarations (by name) that may mention the identifiers:
   * a retained schema or foreign key, a posture inventory, a codec stage.
   * Never a directory- or file-wide permission.
   */
  declarations: readonly string[];
  /**
   * Exact string literals that may mention them anywhere in the file:
   * routine signatures in a deployed-schema grant inventory, never an
   * executable query.
   */
  literals?: readonly string[];
  reason: string;
};

export type LegacySubscriptionRuntime = {
  /** Shown in findings, for example "Codex (M3 PR4)". */
  name: string;
  /** Identifiers and SQL names whose executable use is retired. */
  identifiers: readonly string[];
  /** Retired call or literal shapes whose identifiers stay shared. */
  patterns?: readonly { pattern: RegExp; message: string }[];
  /** Module specifiers a runtime file must not import: deleted producers. */
  deletedModules?: readonly RegExp[];
  /**
   * Historical fixture module names (matched on a path segment or basename)
   * that only tests may import.
   */
  testFixtures?: RegExp;
  /** Exceptions keyed by repository-relative file path. */
  exceptions: Readonly<Record<string, LegacyRuntimeException>>;
};
