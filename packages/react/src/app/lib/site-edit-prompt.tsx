import type { ArtifactKind } from "./artifact-catalog";

/** The start of a new chat that creates an artifact, for the person to finish. */
export function newArtifactPrompt(kind: ArtifactKind | "all"): string {
  return kind === "all" || kind === "file"
    ? "Create a workspace artifact: "
    : kind === "site"
      ? "Create an app: "
      : `Create a workspace ${kind}: `;
}
