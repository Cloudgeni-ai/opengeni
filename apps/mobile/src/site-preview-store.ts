import { Directory, File, Paths } from "expo-file-system";

/*
 * A Site's preview is rendered once per version and theme, captured as a
 * picture and kept in the app's cache folder, so scrolling back (or opening
 * the app again) shows the picture without running the page again. Sign-out
 * empties the folder. Versions that stayed blank are remembered until the app
 * restarts, so their cards keep the type glyph without trying again.
 */
const SITE_PREVIEW_FOLDER = "opengeni-artifact-previews";
const sitePreviews = new Map<string, string>();
export const blankSitePreviews = new Set<string>();

function previewFolder(): Directory {
  return new Directory(Paths.cache, SITE_PREVIEW_FOLDER);
}

export function storedSitePreview(name: string): string | null {
  const known = sitePreviews.get(name);
  if (known) return known;
  try {
    const file = new File(previewFolder(), name);
    if (!file.exists) return null;
    sitePreviews.set(name, file.uri);
    return file.uri;
  } catch {
    return null;
  }
}

export function keepSitePreview(name: string, capturedUri: string): string {
  let uri = capturedUri;
  try {
    const folder = previewFolder();
    if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
    const target = new File(folder, name);
    new File(capturedUri).moveSync(target, { overwrite: true });
    uri = target.uri;
  } catch {
    // The capture itself still shows for this run.
  }
  sitePreviews.set(name, uri);
  return uri;
}

/** Forget every captured Site preview (sign-out: nothing of an account stays). */
export function forgetArtifactPreviews(): void {
  sitePreviews.clear();
  blankSitePreviews.clear();
  try {
    const folder = previewFolder();
    if (folder.exists) folder.delete();
  } catch {
    // Best effort: the system clears its cache folder too.
  }
}
