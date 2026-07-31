import type { FirstPartyMcpToolName, Permission, ToolRef } from "@opengeni/contracts";

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

const ARTIFACT_RUNTIME_CONTRACT = `The artifact runs as untrusted code in a scripts-only, opaque-origin sandbox. Inline JavaScript and DOM interactivity work. Network requests, external assets, form submission, downloads, browser storage, OpenGeni credentials, parent-page access, and workspace APIs are unavailable. Do not add controls that depend on those blocked capabilities. Use inline CSS and JavaScript only.`;

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
