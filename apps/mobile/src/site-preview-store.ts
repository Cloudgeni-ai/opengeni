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

/*
 * Sign-out starts a new generation: a capture that finishes afterwards is
 * thrown away instead of written back, and in-memory caches elsewhere (pages,
 * pictures) are emptied through `onForgetArtifactPreviews`.
 */
let generation = 0;
const forgetters = new Set<() => void>();

export function sitePreviewGeneration(): number {
  return generation;
}

/** Run `forget` whenever previews are forgotten (sign-out). */
export function onForgetArtifactPreviews(forget: () => void): () => void {
  forgetters.add(forget);
  return () => forgetters.delete(forget);
}

/**
 * Keep a captured preview under `name`, replacing the same Site's other
 * versions (files starting with `replaces`; the version's other theme stays).
 * Returns null when the capture belongs to an earlier generation (the account
 * signed out meanwhile).
 */
export function keepSitePreview(
  name: string,
  capturedUri: string,
  options: { generation: number; replaces?: string | undefined },
): string | null {
  if (options.generation !== generation) {
    try {
      new File(capturedUri).delete();
    } catch {
      // A temporary file; the system clears it too.
    }
    return null;
  }
  let uri = capturedUri;
  try {
    const folder = previewFolder();
    if (!folder.exists) folder.create({ intermediates: true, idempotent: true });
    if (options.replaces) {
      // `<prefix><version>~<theme>.jpg`: this version's files share `<prefix><version>~`.
      const version = name.slice(0, name.lastIndexOf("~") + 1);
      for (const entry of folder.list()) {
        if (
          entry instanceof File &&
          entry.name.startsWith(options.replaces) &&
          !entry.name.startsWith(version)
        ) {
          for (const [known, knownUri] of sitePreviews)
            if (knownUri === entry.uri) sitePreviews.delete(known);
          entry.delete();
        }
      }
    }
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
  generation += 1;
  sitePreviews.clear();
  blankSitePreviews.clear();
  for (const forget of forgetters) forget();
  try {
    const folder = previewFolder();
    if (folder.exists) folder.delete();
  } catch {
    // Best effort: the system clears its cache folder too.
  }
}
