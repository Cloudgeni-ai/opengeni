/**
 * How long a saved file's object URL stays valid. Browsers start the save
 * asynchronously after the click, and Firefox fails the download when the URL
 * is revoked first, so the URL outlives the click by a generous margin.
 */
export const SAVED_OBJECT_URL_LIFETIME_MS = 60_000;

/**
 * Starts a browser download of `href` as `filename`. The anchor is attached to
 * the document for the click, which some browsers require, then removed.
 */
export function clickDownloadLink(href: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

/**
 * Saves `blob` as a file named `filename`. The object URL is revoked only after
 * {@link SAVED_OBJECT_URL_LIFETIME_MS}, never immediately after the click.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    clickDownloadLink(url, filename);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), SAVED_OBJECT_URL_LIFETIME_MS);
  }
}
