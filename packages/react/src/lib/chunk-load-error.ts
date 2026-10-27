const CHUNK_LOAD_MESSAGE_PATTERNS = [
  /failed to fetch dynamically imported module/i, // Chromium
  /error loading dynamically imported module/i, // Firefox
  /importing a module script failed/i, // Safari
  /unable to preload css/i, // Vite preload helper
  /failed to load module script/i, // HTML served for a removed asset
  /loading (?:css )?chunk \S+ failed/i, // webpack
];

/**
 * Code that could not be fetched: a lazy part of the UI whose file failed to
 * download (a dropped connection, a certificate or proxy change, or a deploy
 * that replaced it). Retrying in place can't help; React and the browser keep
 * the failed import, so only a reload fetches it again.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  return (
    typeof message === "string" &&
    CHUNK_LOAD_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
  );
}
