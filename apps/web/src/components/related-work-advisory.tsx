import { Clock3Icon, Link2Icon, ShieldCheckIcon } from "lucide-react";
import type { WorkClaimDiscoverySummary, WorkDiscoveryProjection } from "@opengeni/contracts";

import { relativeTimeLabel } from "@/lib/sessions-group";
import { cn } from "@/lib/utils";

const MATCH_LABELS = {
  exact_subject: "Exact typed subject match",
  title: "Matching session title",
  goal: "Matching active goal",
  fuzzy: "Related typed work claim",
} as const;

const ROLE_LABELS = {
  working: "Working",
  reviewing: "Reviewing",
  monitoring: "Monitoring",
  delivering: "Delivering",
} as const;

const STATE_LABELS = {
  active: "Active",
  released: "Released",
  superseded: "Superseded",
  stale: "Stale",
} as const;

const PROVENANCE_LABELS = {
  explicit_agent: "Agent reported",
  user_api: "User or API reported",
  trusted_integration: "Integration reported",
  session_resource: "Session resource",
  system_lifecycle: "Lifecycle settled",
} as const;

const VERSION_LABELS = {
  git_commit: "Commit",
  branch_head: "Branch head",
  pull_request_head: "PR head",
  artifact_version: "Artifact",
  release_version: "Release",
  ci_run: "CI run",
  other: "Version",
} as const;

export function relatedWorkMatchLabel(projection: WorkDiscoveryProjection): string | null {
  const match = projection.match;
  if (!match) return null;
  const strength =
    match.scoreBand === "exact" ? "exact" : match.scoreBand === "strong" ? "strong" : "related";
  return `${MATCH_LABELS[match.class]} · ${strength}`;
}

function claimDisplayLabel(claim: WorkClaimDiscoverySummary): string {
  return claim.subject.displayLabel?.trim() || claim.subject.canonicalKey;
}

function claimVersionLabel(claim: WorkClaimDiscoverySummary): string | null {
  if (!claim.version) return null;
  return `${VERSION_LABELS[claim.version.kind]} ${claim.version.value}`;
}

export function RelatedWorkAdvisory({
  projection,
  className,
}: {
  projection: WorkDiscoveryProjection;
  className?: string;
}) {
  if (!projection.match && projection.claims.length === 0) return null;
  const matchLabel = relatedWorkMatchLabel(projection);
  return (
    <section
      aria-label={projection.possibleOverlap ? "Possible related work" : "Current work evidence"}
      data-related-work-advisory
      className={cn(
        "mt-2 border-l-2 border-status-waiting/40 bg-status-waiting/[0.04] px-2 py-1.5 text-2xs",
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 font-medium text-fg">
          <Link2Icon className="size-3" aria-hidden />
          {projection.possibleOverlap ? "Possible related work" : "Current work evidence"}
        </span>
        {matchLabel ? <span className="text-fg-muted">{matchLabel}</span> : null}
        <span className="ml-auto inline-flex items-center gap-1 text-fg-subtle">
          <ShieldCheckIcon className="size-3" aria-hidden />
          Advisory only · no added access
        </span>
      </div>

      {projection.claims.length > 0 ? (
        <ul className="mt-1.5 space-y-1" aria-label="Related work claims">
          {projection.claims.map((claim) => {
            const displayLabel = claimDisplayLabel(claim);
            const version = claimVersionLabel(claim);
            return (
              <li key={claim.id} className="min-w-0 text-fg-muted">
                <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span className="max-w-full truncate font-medium text-fg" title={displayLabel}>
                    {displayLabel}
                  </span>
                  <span>{ROLE_LABELS[claim.role]}</span>
                  <span aria-hidden>·</span>
                  <span>{STATE_LABELS[claim.state]}</span>
                  {version ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="max-w-72 truncate font-mono" title={version}>
                        {version}
                      </span>
                    </>
                  ) : null}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-fg-subtle">
                  <span>{PROVENANCE_LABELS[claim.provenance]}</span>
                  <span aria-hidden>·</span>
                  <span className="inline-flex items-center gap-1">
                    <Clock3Icon className="size-3" aria-hidden />
                    Updated {relativeTimeLabel(claim.updatedAt)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {projection.claimsTruncated ? (
        <div className="mt-1 text-fg-subtle">More bounded claim evidence is available.</div>
      ) : null}
      <div className="mt-1 text-fg-subtle">
        This evidence does not reserve work, transfer ownership, or authorize another session.
      </div>
    </section>
  );
}
