/**
 * Major-release guard for pending changesets.
 *
 * Opengeni does not ship breaking public API changes in any release
 * (docs/design/api-compatibility-policy.md), so a major version is never the
 * way to ship one. A pending changeset that declares a major release of a
 * public package almost always describes a break the surface diff cannot see:
 * changed behaviour, defaults or error codes. It fails unless its summary
 * names an approved exception on a line of the form
 * `Compatibility exception: <link to the recorded approval>`.
 *
 * Run on every PR and batch by `scripts/ci/changeset-plan.ts`, over the
 * release planner's parsed changesets.
 */

/** Packages whose major release signals a change to the public surface. */
export const PUBLIC_PACKAGES: readonly string[] = ["@opengeni/sdk", "@opengeni/react"];

export type PlannedChangeset = {
  id?: string;
  summary?: string;
  releases: readonly unknown[];
};

const EXCEPTION_LINE = /^\s*Compatibility exception:\s*(\S.*)$/m;
const REFERENCE = /(https?:\/\/|docs\/)/;

export function majorChangesetFailures(changesets: readonly PlannedChangeset[]): string[] {
  const failures: string[] = [];
  for (const changeset of changesets) {
    const majors = changeset.releases.flatMap((release) => {
      const { name, type } = (release ?? {}) as { name?: unknown; type?: unknown };
      return type === "major" && typeof name === "string" && PUBLIC_PACKAGES.includes(name)
        ? [name]
        : [];
    });
    if (majors.length === 0) continue;
    const exception = EXCEPTION_LINE.exec(changeset.summary ?? "")?.[1] ?? "";
    if (REFERENCE.test(exception)) continue;
    failures.push(
      `.changeset/${changeset.id ?? "<unknown>"}.md declares a major release of ${majors.join(" and ")}. Opengeni does not ship breaking public API changes, and a major version does not permit one: keep the old behaviour, release the change as a minor, or, for an approved exception, add a "Compatibility exception: <link to the approval>" line to the changeset and log it in docs/design/api-compatibility-policy.md.`,
    );
  }
  return failures;
}
