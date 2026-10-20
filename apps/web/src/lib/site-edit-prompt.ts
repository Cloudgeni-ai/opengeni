import type { ArtifactKind } from "@/lib/artifact-catalog";

/**
 * The start of a new chat about editing a Site: which Site, then room for the
 * person to say what to change. It is put in the composer, not sent.
 */
export function siteEditPrompt(
  workspaceId: string,
  site: Readonly<{ id: string; title: string }>,
): string {
  return `Edit the Site “${site.title}” (/workspaces/${workspaceId}/artifacts/${site.id}): `;
}

/** The start of a new chat that creates an artifact, for the person to finish. */
export function newArtifactPrompt(kind: ArtifactKind | "all"): string {
  return kind === "all" || kind === "file"
    ? "Create a workspace artifact: "
    : `Create a workspace ${kind}: `;
}
