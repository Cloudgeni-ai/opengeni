/** Example-owned Site authoring prompts, not an SDK API. These selections do not grant
 * permissions: normal session and tool admission remain authoritative. */
export const ARTIFACT_CREATE_PERMISSIONS = ["artifacts:publish"] as const;
export const ARTIFACT_EDIT_PERMISSIONS = ["artifacts:read", "artifacts:publish"] as const;
export const ARTIFACT_CREATE_TOOLS = ["artifacts_create"] as const;
export const ARTIFACT_EDIT_TOOLS = ["artifacts_get_source", "artifacts_publish"] as const;

const ARTIFACT_RUNTIME_CONTRACT = `Sites publish as one self-contained compiled HTML document in an opaque-origin sandboxed iframe. JavaScript, event handlers, forms, network requests, popups, and downloads work. The Site cannot access OpenGeni credentials, parent-page DOM/storage, same-origin authority, or top-level navigation. When workspace tools are needed, request only their exact gateway identities and use createOpenGeniSiteClient from @opengeni/sdk/site; the active immutable version's requested identities are its direct-call allowlist, while the parent keeps workspace identity and credentials outside the iframe and intersects that allowlist with the viewer's live authority. Prefer @opengeni/react components and the workspace design system for the source app.`;

export function artifactCreateOpeningMessage(): string {
  return "Help me build a workspace Site.";
}
export function artifactCreateInstructions(): string {
  return `You are the Site author for this session. Load and follow the opengeni-sites Skill, then ask me what the Site should do. After I answer, create a normal Bun + React source project in the workspace, use ordinary packages and build tooling, compile it to one self-contained HTML document, and call artifacts_create yourself with both the retained source bundle and compiled HTML before replying that the work is complete. In the completion reply, include a standard Markdown link to /workspaces/<workspaceId>/artifacts/<artifactId> using the exact artifact.workspaceId and artifact.id returned by artifacts_create. Do not create, spawn, or delegate to another session, and do not stop after merely writing or validating files. ${ARTIFACT_RUNTIME_CONTRACT} A Site may be a page, visualization, gallery, dashboard, workflow, or focused app.`;
}
export function artifactEditOpeningMessage(title: string): string {
  return `Help me edit “${title}”.`;
}
export function artifactEditInstructions(input: {
  artifactId: string;
  title: string;
  currentVersionId: string;
  /** Trusted host navigation only, never user-supplied authorization. */
  completionHref?: string;
}): string {
  let completion =
    "In the completion reply, include a standard Markdown link to /workspaces/<workspaceId>/artifacts/<artifactId> using the exact artifact.workspaceId and artifact.id returned by artifacts_publish.";
  if (input.completionHref !== undefined) {
    const href = input.completionHref;
    if (/[\u0000-\u0020\u007f]/.test(href)) throw new Error("Invalid Site completion link");
    const parsed = new URL(href, "https://host.invalid");
    if (
      !["https:", "http:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      href.startsWith("//")
    )
      throw new Error("Invalid Site completion link");
    completion = `In the completion reply, link to the host-owned Site destination ${JSON.stringify(href)}. Do not substitute an OpenGeni console URL.`;
  }
  return `You are editing the workspace Site "${input.title}" (artifact id ${input.artifactId}). Load and follow the opengeni-sites Skill, then ask me what I want changed. After I answer, call artifacts_get_source yourself, restore its retained Bun + React source, make and validate the requested changes, compile it to one self-contained HTML document, and call artifacts_publish yourself with both source and HTML in this same session using current version ${input.currentVersionId} for optimistic concurrency. ${completion} Do not create, spawn, or delegate to another session, and do not stop after merely writing or validating files. ${ARTIFACT_RUNTIME_CONTRACT}`;
}
