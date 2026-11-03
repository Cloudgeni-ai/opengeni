/**
 * Major-release guard for the pending release plan.
 *
 * Opengeni does not ship breaking public API changes in any release
 * (docs/design/api-compatibility-policy.md), so a major version is never the
 * way to ship one. All published packages share one `fixed` version group, so
 * a major declared on any package (for example `@opengeni/contracts` when a
 * wire shape narrows) also releases `@opengeni/sdk` and `@opengeni/react` as
 * majors. Whenever the computed plan releases either of them as a major, every
 * pending changeset that declares a major must name an approved exception on a
 * line of the form
 * `Compatibility exception: <link to the recorded approval>`, where the link is
 * a Cloudgeni-ai/opengeni GitHub URL or the policy's exception log. A major
 * that no changeset declares (it propagated through dependencies) fails too.
 *
 * Run on every PR and batch by `scripts/ci/changeset-plan.ts`, over the
 * release planner's parsed changesets and computed releases.
 */

/** Packages whose major release signals a change to the public surface. */
export const PUBLIC_PACKAGES: readonly string[] = ["@opengeni/sdk", "@opengeni/react"];

export type PlannedChangeset = {
  id?: string;
  summary?: string;
  releases: readonly unknown[];
};

const EXCEPTION_LINE = /^\s*Compatibility exception:\s*(\S.*)$/m;
const APPROVAL_LINK =
  /(https:\/\/github\.com\/Cloudgeni-ai\/opengeni\/\S+|docs\/design\/api-compatibility-policy\.md#\S+)/;

function releaseFields(release: unknown): { name?: unknown; type?: unknown } {
  return (release ?? {}) as { name?: unknown; type?: unknown };
}

/** The approval link a changeset summary names, ignoring fenced code blocks. */
export function compatibilityException(summary: string | undefined): string | undefined {
  const prose = (summary ?? "").replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, "");
  const exception = EXCEPTION_LINE.exec(prose)?.[1] ?? "";
  return APPROVAL_LINK.exec(exception)?.[1];
}

export function majorReleaseFailures(
  changesets: readonly PlannedChangeset[],
  releases: readonly unknown[],
): string[] {
  const publicMajors = releases.flatMap((release) => {
    const { name, type } = releaseFields(release);
    return type === "major" && typeof name === "string" && PUBLIC_PACKAGES.includes(name)
      ? [name]
      : [];
  });
  if (publicMajors.length === 0) return [];
  const released = [...new Set(publicMajors)].sort().join(" and ");
  const remedy = `Opengeni does not ship breaking public API changes, and a major version does not permit one: keep the old behaviour, release the change as a minor or patch, or, for an approved exception, add a "Compatibility exception: <link to the approval>" line (a github.com/Cloudgeni-ai/opengeni URL or docs/design/api-compatibility-policy.md#exception-log) to the changeset and log it in docs/design/api-compatibility-policy.md.`;
  const failures: string[] = [];
  let declared = 0;
  for (const changeset of changesets) {
    const majors = changeset.releases.flatMap((release) => {
      const { name, type } = releaseFields(release);
      return type === "major" && typeof name === "string" ? [name] : [];
    });
    if (majors.length === 0) continue;
    declared += 1;
    if (compatibilityException(changeset.summary)) continue;
    failures.push(
      `.changeset/${changeset.id ?? "<unknown>"}.md declares a major release of ${majors.join(" and ")}, which releases ${released} as a major. ${remedy}`,
    );
  }
  if (declared === 0)
    failures.push(
      `The pending release plan releases ${released} as a major although no changeset declares one (it propagated through dependencies). ${remedy}`,
    );
  return failures;
}
