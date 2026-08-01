import type { FirstPartyMcpToolName, Permission, ToolRef } from "@opengeni/contracts";

import type { ReasoningEffort, TurnSubmission } from "@/types";

/**
 * Artifact authoring needs only OpenGeni's mandatory first-party MCP server.
 * Keep this explicit so workspace-default Files/docs servers are not attached
 * to the artifact-only delegated grant and rejected during MCP startup.
 */
export const ARTIFACT_SESSION_TOOLS = [
  { kind: "mcp", id: "opengeni" },
] as const satisfies readonly ToolRef[];

export const ARTIFACT_CREATE_PERMISSIONS = [
  "artifacts:publish",
] as const satisfies readonly Permission[];

export const ARTIFACT_EDIT_PERMISSIONS = [
  "artifacts:read",
  "artifacts:publish",
] as const satisfies readonly Permission[];

export const ARTIFACT_CREATE_TOOLS = [
  "artifacts_create",
] as const satisfies readonly FirstPartyMcpToolName[];

export const ARTIFACT_EDIT_TOOLS = [
  "artifacts_get_source",
  "artifacts_publish",
] as const satisfies readonly FirstPartyMcpToolName[];

const ARTIFACT_RUNTIME_CONTRACT = `For this MVP, artifacts render as static HTML and inline CSS only. JavaScript, event handlers, forms, embeds, navigation-capable markup, network requests, external assets, downloads, browser storage, OpenGeni credentials, parent-page access, and workspace APIs are removed or blocked. Do not include scripts or controls that require JavaScript. Use semantic HTML and inline CSS only; CSS-only interactions and responsive layouts are supported.`;

export function artifactCreateOpeningMessage(): string {
  return "Help me create a workspace artifact.";
}

export function artifactCreateInstructions(): string {
  return `You are the artifact author for this session. Ask me what the artifact should do. After I answer, build a polished, responsive, accessible, complete self-contained HTML document and call artifacts_create yourself in this same session before replying that the work is complete. Do not create, spawn, or delegate to another session, and do not stop after merely writing or validating a file. ${ARTIFACT_RUNTIME_CONTRACT} Keep the artifact primitive generic: it may be an app, page, visualization, gallery, dashboard, document-like experience, or anything else.`;
}

export function artifactEditOpeningMessage(title: string): string {
  return `Help me edit “${title}”.`;
}

export function artifactEditInstructions(input: {
  artifactId: string;
  title: string;
  currentVersionId: string;
}): string {
  return `You are editing the workspace artifact "${input.title}" (artifact id ${input.artifactId}). Ask me what I want changed. After I answer, call artifacts_get_source yourself, make the requested changes, and call artifacts_publish yourself in this same session with current version ${input.currentVersionId} for optimistic concurrency. Do not create, spawn, or delegate to another session, and do not stop after merely writing or validating a file. Publish the complete updated HTML before replying that the work is complete. ${ARTIFACT_RUNTIME_CONTRACT}`;
}

/** Apply the actor's durable new-session model preference without replacing an explicit choice. */
export function applyNewSessionModelPreference(
  submission: TurnSubmission,
  preference: { model: string; reasoningEffort: ReasoningEffort },
): TurnSubmission {
  return {
    ...submission,
    model: submission.model ?? preference.model,
    reasoningEffort: submission.reasoningEffort ?? preference.reasoningEffort,
  };
}
