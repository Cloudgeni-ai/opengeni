/**
 * A heavy Site page: a warning for the agent that published it, never a
 * refusal. Pages this large usually embed images or video as data URLs,
 * which every visitor downloads before anything shows.
 */

/** Above this, a published page gets a warning (the page itself, not its separate files). */
export const SITE_PAGE_HEAVY_BYTES = 5 * 1024 * 1024;
/** The largest page the Sites gateway serves (apps/site-gateway SITE_FRAME_MAX_BYTES). */
export const SITE_PAGE_SERVED_MAX_BYTES = 256 * 1024 * 1024;

export type SitePageSizeWarning = {
  code: "page_heavy" | "page_too_large";
  message: string;
  suggestion: string;
};

function megabytes(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} MB`;
}

const SUGGESTION =
  "Shrink or move the media: resize and compress images to the size they are shown (WebP or JPEG), and link video or large images from where they are hosted instead of embedding them. For a Site only signed-in people open, Site files can hold them too (at most 10 MB each; anonymous visitors can't read them). Keep the page itself under 5 MB.";

/** The warnings for a published page of this size (empty for an ordinary page). */
export function sitePageSizeWarnings(sizeBytes: number): SitePageSizeWarning[] {
  if (sizeBytes > SITE_PAGE_SERVED_MAX_BYTES)
    return [
      {
        code: "page_too_large",
        message: `This Site's page is ${megabytes(sizeBytes)}, more than the ${megabytes(SITE_PAGE_SERVED_MAX_BYTES)} a published Site page can be, so its link shows "Site too large" instead of the page.`,
        suggestion: SUGGESTION,
      },
    ];
  if (sizeBytes > SITE_PAGE_HEAVY_BYTES)
    return [
      {
        code: "page_heavy",
        message: `This Site's page is ${megabytes(sizeBytes)}, so it loads slowly: visitors download all of it before anything shows. Images or video embedded as data URLs are the usual cause.`,
        suggestion: SUGGESTION,
      },
    ];
  return [];
}

/** A publish result with the page's size warnings, when there are any. */
export function withSitePageSizeWarnings<T extends { version: { sizeBytes: number } }>(
  result: T,
): T & { warnings?: SitePageSizeWarning[] } {
  const warnings = sitePageSizeWarnings(result.version.sizeBytes);
  return warnings.length > 0 ? { ...result, warnings } : result;
}
