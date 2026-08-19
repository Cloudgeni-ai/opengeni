import {
  COMPANY_BRAIN_GUIDANCE_MAX_CONTENT_BYTES,
  COMPANY_BRAIN_GUIDANCE_MAX_ENTRIES,
  CompanyBrainOkfPackage,
  type CompanyBrainGuidanceEntry,
  type CompanyBrainGuidanceTruncationReason,
  type CompanyBrainOkfPackage as CompanyBrainOkfPackageType,
  type CompanyProfileListResponse,
  type WorkspaceInstructionPolicyListResponse,
  type WorkspaceInstructionPolicyRevision,
  type WorkspaceStateKnowledge,
} from "@opengeni/contracts";
import type { CompanyBrainPreferenceGuidancePage } from "@opengeni/db";

const OKF_MARKER = "<!-- opengeni-company-brain-okf-v1 -->";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function companyProfileEntries(profile: CompanyProfileListResponse): {
  entries: CompanyBrainGuidanceEntry[];
  truncated: boolean;
} {
  const activeRevisionId = profile.current?.revisionId ?? null;
  const byId = new Map(profile.revisions.map((revision) => [revision.id, revision] as const));
  if (profile.activeRevision) byId.set(profile.activeRevision.id, profile.activeRevision);
  return {
    entries: [...byId.values()].map((revision) => {
      const active = revision.id === activeRevisionId;
      return {
        id: "company-profile",
        revisionId: revision.id,
        path: "company/profile",
        scope: "organization",
        classification: "company_profile",
        title: "Company profile",
        description: "Company identity, mission, products, customers, goals, and constraints.",
        // Company-profile hashes cover this exact canonical field order.
        content: JSON.stringify(revision.profile),
        contentHash: revision.contentHash,
        revision: revision.revision,
        active,
        lifecycle: active ? "active" : revision.intent === "proposal" ? "proposal" : "historical",
        provenance: {
          source: revision.provenance.source,
          sourceId: revision.provenance.sourceId,
          trust: revision.intent === "proposal" ? "untrusted_proposal" : "organization_managed",
        },
        relationships:
          revision.supersedesRevisionId && byId.has(revision.supersedesRevisionId)
            ? [{ type: "supersedes" as const, targetId: revision.supersedesRevisionId }]
            : [],
        createdAt: revision.createdAt,
      } satisfies CompanyBrainGuidanceEntry;
    }),
    truncated: profile.nextAfterRevision !== null,
  };
}

function instructionPolicyEntries(
  policies: WorkspaceInstructionPolicyListResponse,
  activeRevisions: WorkspaceInstructionPolicyRevision[],
  activatedRevisionIds: string[],
): { entries: CompanyBrainGuidanceEntry[]; truncated: boolean } {
  const byId = new Map(policies.revisions.map((revision) => [revision.id, revision] as const));
  for (const revision of activeRevisions) byId.set(revision.id, revision);
  const activeIds = new Set(policies.activeHeads.map((head) => head.revisionId));
  const activatedIds = new Set(activatedRevisionIds);
  return {
    entries: [...byId.values()].map((revision) => {
      const roleSegment = revision.roleKey ?? "all";
      const active = activeIds.has(revision.id);
      const lifecycle = active
        ? "active"
        : activatedIds.has(revision.id)
          ? "historical"
          : revision.provenance.source === "onboarding" ||
              revision.provenance.source === "knowledge_proposal"
            ? "proposal"
            : "inactive";
      return {
        id: `instruction-policy:${revision.kind}:${revision.scope}:${roleSegment}`,
        revisionId: revision.id,
        path: `ways-of-working/rules/${revision.kind}/${revision.scope}/${roleSegment}`,
        scope: "workspace",
        classification: "mandatory_rule",
        title:
          revision.kind === "charter"
            ? "Workspace charter"
            : revision.scope === "role"
              ? `Role policy: ${roleSegment}`
              : "Workspace policy",
        description: active ? "Mandatory context included for applicable agents." : null,
        content: revision.content,
        contentHash: revision.contentHash,
        revision: revision.revision,
        active,
        lifecycle,
        provenance: {
          source: revision.provenance.source,
          sourceId: revision.provenance.sourceId,
          trust:
            revision.provenance.source === "human"
              ? "workspace_managed"
              : revision.provenance.source === "legacy_import"
                ? "migrated"
                : "untrusted_proposal",
        },
        relationships:
          revision.supersedesRevisionId && byId.has(revision.supersedesRevisionId)
            ? [{ type: "supersedes" as const, targetId: revision.supersedesRevisionId }]
            : [],
        createdAt: revision.createdAt,
      } satisfies CompanyBrainGuidanceEntry;
    }),
    truncated: policies.nextAfterRevision !== null,
  };
}

function preferenceLifecycle(
  row: CompanyBrainPreferenceGuidancePage["rows"][number],
  generatedAt: string,
): CompanyBrainGuidanceEntry["lifecycle"] {
  if (row.active && row.expiresAt && row.expiresAt.getTime() <= Date.parse(generatedAt)) {
    return "expired";
  }
  if (row.active && row.status === "active") return "active";
  if (row.status === "proposed") return "proposal";
  if (row.status === "inactive") return "inactive";
  if (row.status === "rejected") return "rejected";
  if (row.status === "superseded") return "superseded";
  return "historical";
}

function preferenceEntries(
  page: CompanyBrainPreferenceGuidancePage,
  generatedAt: string,
): CompanyBrainGuidanceEntry[] {
  const visibleRevisionIds = new Set(page.rows.map((row) => row.revisionId));
  const visiblePreferenceIds = new Set(page.rows.map((row) => row.preferenceId));
  return page.rows.map((row) => {
    const scope =
      row.scope === "organization"
        ? "organization"
        : row.scope === "user"
          ? "personal"
          : "workspace";
    const lifecycle = preferenceLifecycle(row, generatedAt);
    const relationships: CompanyBrainGuidanceEntry["relationships"] = [];
    if (row.correctsRevisionId && visibleRevisionIds.has(row.correctsRevisionId)) {
      relationships.push({ type: "corrects", targetId: row.correctsRevisionId });
    }
    if (row.supersededByPreferenceId && visiblePreferenceIds.has(row.supersededByPreferenceId)) {
      relationships.push({
        type: "superseded_by",
        targetId: `preference:${row.supersededByPreferenceId}`,
      });
    }
    return {
      id: `preference:${row.preferenceId}`,
      revisionId: row.revisionId,
      path: `ways-of-working/guides/${scope}/${row.stableKey}`,
      scope,
      classification: "guide",
      title: row.title,
      description: row.description,
      content: row.content,
      contentHash: row.contentHash,
      revision: row.revision,
      active: lifecycle === "active",
      lifecycle,
      provenance: {
        source: row.provenanceSource,
        sourceId: row.provenanceSourceId,
        trust: row.trust,
      },
      relationships,
      createdAt: row.createdAt.toISOString(),
    } satisfies CompanyBrainGuidanceEntry;
  });
}

function guidanceEntryOrder(
  left: CompanyBrainGuidanceEntry,
  right: CompanyBrainGuidanceEntry,
): number {
  return (
    left.classification.localeCompare(right.classification) ||
    left.path.localeCompare(right.path) ||
    right.revision - left.revision ||
    left.revisionId.localeCompare(right.revisionId)
  );
}

function relationshipTargetKeys(entry: CompanyBrainGuidanceEntry): string[] {
  return [entry.id, entry.revisionId];
}

export function boundCompanyBrainGuidanceEntries(entries: CompanyBrainGuidanceEntry[]): {
  entries: CompanyBrainGuidanceEntry[];
  itemCountTruncated: boolean;
  contentBytesTruncated: boolean;
} {
  const prioritized = [...entries].sort(
    (left, right) => Number(right.active) - Number(left.active) || guidanceEntryOrder(left, right),
  );
  const selected: CompanyBrainGuidanceEntry[] = [];
  let contentBytes = 0;
  let itemCountTruncated = false;
  let contentBytesTruncated = false;
  for (const entry of prioritized) {
    if (selected.length >= COMPANY_BRAIN_GUIDANCE_MAX_ENTRIES) {
      itemCountTruncated = true;
      continue;
    }
    const entryBytes = new TextEncoder().encode(entry.content).byteLength;
    if (contentBytes + entryBytes > COMPANY_BRAIN_GUIDANCE_MAX_CONTENT_BYTES) {
      contentBytesTruncated = true;
      continue;
    }
    selected.push(entry);
    contentBytes += entryBytes;
  }
  const visibleTargets = new Set(selected.flatMap(relationshipTargetKeys));
  return {
    entries: selected
      .map((entry) => ({
        ...entry,
        relationships: entry.relationships.filter((relationship) =>
          visibleTargets.has(relationship.targetId),
        ),
      }))
      .sort(guidanceEntryOrder),
    itemCountTruncated,
    contentBytesTruncated,
  };
}

export function createCompanyBrainOkfPackage(input: {
  workspaceId: string;
  generatedAt: string;
  companyProfile: CompanyProfileListResponse;
  instructionPolicies: WorkspaceInstructionPolicyListResponse;
  activeInstructionPolicyRevisions: WorkspaceInstructionPolicyRevision[];
  activatedInstructionPolicyRevisionIds: string[];
  preferences: CompanyBrainPreferenceGuidancePage;
  knowledge: WorkspaceStateKnowledge;
}): CompanyBrainOkfPackageType {
  const company = companyProfileEntries(input.companyProfile);
  const policies = instructionPolicyEntries(
    input.instructionPolicies,
    input.activeInstructionPolicyRevisions,
    input.activatedInstructionPolicyRevisionIds,
  );
  const preferences = preferenceEntries(input.preferences, input.generatedAt);
  const truncationReasons: CompanyBrainGuidanceTruncationReason[] = [];
  if (company.truncated) truncationReasons.push("company_profile_history");
  if (policies.truncated) truncationReasons.push("instruction_policy_history");
  if (input.preferences.preferenceCountTruncated) truncationReasons.push("preference_count");
  if (input.preferences.revisionCountTruncated) truncationReasons.push("preference_history");
  if (input.preferences.contentBytesTruncated) truncationReasons.push("aggregate_content_bytes");

  const bounded = boundCompanyBrainGuidanceEntries([
    ...company.entries,
    ...policies.entries,
    ...preferences,
  ]);
  if (bounded.itemCountTruncated) truncationReasons.push("aggregate_item_count");
  if (bounded.contentBytesTruncated && !truncationReasons.includes("aggregate_content_bytes")) {
    truncationReasons.push("aggregate_content_bytes");
  }
  const knowledgeAvailable = input.knowledge.availability === "available";
  return CompanyBrainOkfPackage.parse({
    kind: "opengeni.company_brain.okf",
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    generatedAt: input.generatedAt,
    permissions: {
      guidance: "available",
      knowledge: knowledgeAvailable ? "available" : "unavailable",
    },
    guidance: {
      entries: bounded.entries,
      truncated: truncationReasons.length > 0,
      truncationReasons,
    },
    knowledge: input.knowledge,
    omissions: [
      ...(knowledgeAvailable ? [] : (["inaccessible_knowledge"] as const)),
      "document_bodies_use_documents_export",
      "memory_bodies_and_provenance",
      "secret_values_and_credentials",
      "session_messages_and_task_notes",
      "policy_and_preference_actor_identifiers",
    ],
  });
}

/**
 * JSON is a strict subset of YAML 1.2. Keeping the payload in one fenced YAML
 * block gives humans a readable Markdown package while making arbitrary
 * guidance Markdown structurally inert and exactly round-trippable.
 */
export function serializeCompanyBrainOkf(value: CompanyBrainOkfPackageType): string {
  const parsed = CompanyBrainOkfPackage.parse(value);
  return [
    OKF_MARKER,
    "# OpenGeni Company Brain",
    "",
    "This permission-filtered package is portable evidence. Postgres remains canonical.",
    "",
    "```yaml",
    canonicalJson(parsed).trimEnd(),
    "```",
    "",
  ].join("\n");
}

export function parseCompanyBrainOkf(markdown: string): CompanyBrainOkfPackageType {
  if (!markdown.startsWith(`${OKF_MARKER}\n`)) throw new Error("Invalid Company Brain OKF marker");
  const opening = markdown.indexOf("```yaml\n");
  if (opening < 0) throw new Error("Company Brain OKF payload is missing");
  const payloadStart = opening + "```yaml\n".length;
  const closing = markdown.indexOf("\n```", payloadStart);
  if (closing < 0) throw new Error("Company Brain OKF payload is incomplete");
  const trailing = markdown.slice(closing + "\n```".length).trim();
  if (trailing.length > 0) throw new Error("Company Brain OKF has unexpected trailing content");
  return CompanyBrainOkfPackage.parse(JSON.parse(markdown.slice(payloadStart, closing)));
}
