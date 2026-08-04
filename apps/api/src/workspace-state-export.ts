import { createHash } from "node:crypto";
import {
  WORKSPACE_STATE_EXPORT_SCHEMA_VERSION,
  WorkspaceStateExportResponse,
  type WorkspaceStateExportResponse as WorkspaceStateExportResponseType,
  type WorkspaceStateResponse,
} from "@opengeni/contracts";

const WORKSPACE_STATE_EXPORT_OMISSIONS = [
  "hidden_platform_prompts",
  "policy_bodies",
  "preference_content",
  "document_content_and_private_metadata",
  "memory_content_and_provenance",
  "secret_values_and_credentials",
  "session_messages_and_tool_outputs",
] as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function canonicalWorkspaceStateJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function createWorkspaceStateExport(
  state: WorkspaceStateResponse,
): WorkspaceStateExportResponseType {
  const canonicalState = canonicalWorkspaceStateJson(state);
  return WorkspaceStateExportResponse.parse({
    kind: "opengeni.workspace_state.sanitized_export",
    schemaVersion: WORKSPACE_STATE_EXPORT_SCHEMA_VERSION,
    generatedAt: state.generatedAt,
    stateSha256: createHash("sha256").update(canonicalState, "utf8").digest("hex"),
    omissions: WORKSPACE_STATE_EXPORT_OMISSIONS,
    state,
  });
}

export function serializeWorkspaceStateExport(state: WorkspaceStateResponse): string {
  return canonicalWorkspaceStateJson(createWorkspaceStateExport(state));
}