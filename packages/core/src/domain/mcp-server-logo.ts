import {
  MAX_LOGO_BYTES,
  MAX_MCP_ICON_ATTEMPTS,
  catalogAssetObjectKey,
  decodeDataUriIcon,
  mcpServerIcons,
  normalizedContentType,
  rankMcpServerIcons,
  validateLogoAsset,
  type LogoAssetValidation,
  type McpIcon,
} from "@opengeni/capabilities";
import type { ObjectStorage } from "@opengeni/storage";

/** Logo storage for a connected MCP server. */
export type McpServerLogoStorage = Pick<ObjectStorage, "putObject">;

/** Fetches one icon URL; callers bind it to the deployment's outbound network policy. */
export type McpServerLogoFetch = (url: string, init: RequestInit) => Promise<Response>;

const ICON_FETCH_TIMEOUT_MS = 5_000;
/** Redirect hops followed for one icon; every hop goes back through the caller's fetch policy. */
const MAX_ICON_REDIRECTS = 3;

/**
 * Stores the best icon a connected MCP server advertises in `serverInfo.icons`
 * and returns its `catalog-assets/...` key, or null when it offers none that
 * passes the catalog's logo rule. Icons go through the same validation as
 * vendored catalog logos and are served by the catalog-asset route, so the
 * browser never loads them from the server's host. Best effort: a server
 * without a usable icon keeps its monogram and its connection is unaffected.
 */
export async function storeMcpServerLogo(input: {
  serverInfo: unknown;
  endpointUrl: string;
  objectStorage: McpServerLogoStorage | null | undefined;
  fetch: McpServerLogoFetch;
}): Promise<string | null> {
  if (!input.objectStorage) return null;
  const candidates = rankMcpServerIcons(mcpServerIcons(input.serverInfo)).slice(
    0,
    MAX_MCP_ICON_ATTEMPTS,
  );
  let host = "server";
  try {
    host = new URL(input.endpointUrl).hostname || host;
  } catch {
    /* Keep the generic namespace. */
  }
  for (const icon of candidates) {
    const asset = await loadIcon(icon, input.fetch);
    if (!asset.ok) continue;
    const key = catalogAssetObjectKey(`mcp-icons/${host}`, asset.sha256, asset.contentType);
    try {
      await input.objectStorage.putObject({
        key,
        contentType: asset.contentType,
        body: asset.bytes,
        sha256: asset.sha256,
      });
      return key;
    } catch {
      return null;
    }
  }
  return null;
}

async function loadIcon(
  icon: McpIcon,
  fetchIcon: McpServerLogoFetch,
): Promise<LogoAssetValidation> {
  if (icon.src.toLowerCase().startsWith("data:")) {
    const decoded = decodeDataUriIcon(icon.src);
    if (!decoded) return { ok: false, reason: "invalid_data_uri" };
    return validateLogoAsset({
      contentType: decoded.contentType ?? icon.mimeType,
      bytes: decoded.bytes,
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ICON_FETCH_TIMEOUT_MS);
  try {
    let url = icon.src;
    let response = await fetchIcon(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "image/*" },
      signal: controller.signal,
    });
    for (let hop = 0; isRedirect(response.status); hop += 1) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      const next = location ? safeRedirectTarget(location, url) : null;
      if (!next || hop >= MAX_ICON_REDIRECTS) return { ok: false, reason: "redirect_refused" };
      url = next;
      response = await fetchIcon(url, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "image/*" },
        signal: controller.signal,
      });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `http_status:${response.status}` };
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_LOGO_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "image_too_large" };
    }
    const bytes = await readCapped(response, MAX_LOGO_BYTES);
    if (!bytes) return { ok: false, reason: "image_too_large" };
    const headerType = normalizedContentType(response.headers.get("content-type"));
    return validateLogoAsset({
      contentType: headerType?.startsWith("image/") ? headerType : icon.mimeType,
      bytes,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `fetch_failed:${error instanceof Error ? error.name : "unknown"}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** An absolute https target for a redirect `Location`, or null. */
function safeRedirectTarget(location: string, base: string): string | null {
  try {
    const target = new URL(location, base);
    return target.protocol === "https:" ? target.toString() : null;
  } catch {
    return null;
  }
}

/** The whole body, or null once it exceeds `limit` bytes. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
