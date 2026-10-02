// Artifacts page view helpers. Kept out of artifact-catalog, which the eager
// session graph imports, so only the lazy Artifacts page carries them.

/** Gallery (preview cards) or List (flat rows); remembered in this browser. */
export type ArtifactView = "gallery" | "list";
export const ARTIFACT_VIEW_KEY = "opengeni:artifact-library:view:v1";
export function readArtifactView(): ArtifactView {
  try {
    return localStorage.getItem(ARTIFACT_VIEW_KEY) === "list" ? "list" : "gallery";
  } catch {
    return "gallery";
  }
}
export function rememberArtifactView(view: ArtifactView) {
  try {
    localStorage.setItem(ARTIFACT_VIEW_KEY, view);
  } catch {
    /* Storage may be disabled. */
  }
}

/** A file's extension for its placeholder ("csv"), or nothing when it has none. */
export function artifactExtension(item: { filename?: string; title: string }): string | null {
  const name = item.filename || item.title;
  const match = /\.([a-z0-9]{1,8})$/i.exec(name);
  return match ? match[1]!.toLocaleLowerCase() : null;
}
