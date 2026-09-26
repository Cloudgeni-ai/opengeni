import { HEADLESS_SHELL_VERSION } from "./headless-shell";
import type { BrowserCdpConnection } from "./cdp-driver";
import type { BrowserProfileManifest } from "./state-artifact";

/** Private memory-only adjunct to the authenticated profile archive. Never a
 * tool result, public manifest, log entry, or plaintext profile sidecar. */
export const HEADLESS_COOKIE_ARCHIVE_PATH = "private/headless-session-cookies.v1.json";
export const HEADLESS_COOKIE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_COOKIES = 4096;
type SessionCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: -1;
  session: true;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  priority: "Low" | "Medium" | "High";
  sourceScheme: "Unset" | "NonSecure" | "Secure";
  sourcePort: number;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
  partitionKeyOpaque?: false;
};
export type HeadlessSessionCookies = {
  schemaVersion: 1;
  shellVersion: typeof HEADLESS_SHELL_VERSION;
  source: { browserSessionId: string; controllerGeneration: string };
  context: "default";
  cookies: SessionCookie[];
};

const failure = () => new Error("Headless session cookie state is invalid or incompatible");
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function closed(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw failure();
}
function text(value: unknown, max: number, empty = false): value is string {
  return (
    typeof value === "string" &&
    (empty || value.length > 0) &&
    Buffer.byteLength(value) <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function cookie(value: unknown, fromCdp = false): SessionCookie {
  if (!record(value)) throw failure();
  closed(value, [
    "name",
    "value",
    "domain",
    "path",
    "expires",
    "session",
    "httpOnly",
    "secure",
    "sameSite",
    "priority",
    "sourceScheme",
    "sourcePort",
    "partitionKey",
    "partitionKeyOpaque",
    ...(fromCdp ? ["size"] : []),
  ]);
  if (
    !text(value.name, 4096, true) ||
    !text(value.value, 16384, true) ||
    !text(value.domain, 512) ||
    !text(value.path, 4096) ||
    !value.path.startsWith("/") ||
    value.expires !== -1 ||
    value.session !== true ||
    typeof value.httpOnly !== "boolean" ||
    typeof value.secure !== "boolean" ||
    !["Low", "Medium", "High"].includes(String(value.priority)) ||
    !["Unset", "NonSecure", "Secure"].includes(String(value.sourceScheme)) ||
    !Number.isInteger(value.sourcePort) ||
    (value.sourcePort !== -1 &&
      (Number(value.sourcePort) < 1 || Number(value.sourcePort) > 65535)) ||
    (value.sameSite !== undefined && !["Strict", "Lax", "None"].includes(String(value.sameSite))) ||
    (value.partitionKeyOpaque !== undefined && value.partitionKeyOpaque !== false)
  )
    throw failure();
  if (value.partitionKey !== undefined) {
    if (!record(value.partitionKey)) throw failure();
    closed(value.partitionKey, ["topLevelSite", "hasCrossSiteAncestor"]);
    if (
      !text(value.partitionKey.topLevelSite, 4096) ||
      typeof value.partitionKey.hasCrossSiteAncestor !== "boolean"
    )
      throw failure();
    let site: URL;
    try {
      site = new URL(value.partitionKey.topLevelSite);
    } catch {
      throw failure();
    }
    if (
      !["http:", "https:"].includes(site.protocol) ||
      site.username ||
      site.password ||
      site.origin !== value.partitionKey.topLevelSite
    )
      throw failure();
  }
  const { size: _size, ...attributes } = value;
  return structuredClone(attributes) as SessionCookie;
}
function cookieKey(value: SessionCookie): string {
  return JSON.stringify([
    value.name,
    value.domain,
    value.path,
    value.partitionKey
      ? [value.partitionKey.topLevelSite, value.partitionKey.hasCrossSiteAncestor]
      : null,
  ]);
}
export function validateHeadlessSessionCookies(value: unknown): HeadlessSessionCookies {
  if (!record(value)) throw failure();
  closed(value, ["schemaVersion", "shellVersion", "source", "context", "cookies"]);
  if (
    value.schemaVersion !== 1 ||
    value.shellVersion !== HEADLESS_SHELL_VERSION ||
    value.context !== "default" ||
    !record(value.source) ||
    !Array.isArray(value.cookies) ||
    value.cookies.length > MAX_COOKIES
  )
    throw failure();
  closed(value.source, ["browserSessionId", "controllerGeneration"]);
  if (!text(value.source.browserSessionId, 128) || !text(value.source.controllerGeneration, 512))
    throw failure();
  const cookies = value.cookies.map((entry) => cookie(entry));
  if (new Set(cookies.map(cookieKey)).size !== cookies.length) throw failure();
  const result = { ...value, cookies } as HeadlessSessionCookies;
  if (Buffer.byteLength(JSON.stringify(result)) > HEADLESS_COOKIE_MAX_BYTES) throw failure();
  return result;
}
export function assertHeadlessCookieManifest(
  state: HeadlessSessionCookies,
  manifest: BrowserProfileManifest,
): void {
  if (
    manifest.engine !== "chromium" ||
    manifest.engineVersion !== state.shellVersion ||
    manifest.driverId !== "opengeni.cdp.v1" ||
    manifest.driverSchemaVersion !== 1 ||
    manifest.platform !== "linux" ||
    manifest.architecture !== "x64" ||
    manifest.profileCrypto !== "chromium_basic" ||
    manifest.browserSessionId !== state.source.browserSessionId ||
    manifest.controllerGeneration !== state.source.controllerGeneration
  )
    throw failure();
}
export function encodeHeadlessSessionCookies(
  state: HeadlessSessionCookies,
  manifest: BrowserProfileManifest,
): Buffer {
  const validated = validateHeadlessSessionCookies(state);
  assertHeadlessCookieManifest(validated, manifest);
  return Buffer.from(JSON.stringify(validated));
}
export function decodeHeadlessSessionCookies(bytes: Uint8Array): HeadlessSessionCookies {
  try {
    if (!bytes.byteLength || bytes.byteLength > HEADLESS_COOKIE_MAX_BYTES) throw failure();
    return validateHeadlessSessionCookies(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    // Never include parser/CDP data, cookie names, origins or values in errors.
    throw failure();
  }
}
async function requireDedicatedDefaultContext(connection: BrowserCdpConnection): Promise<void> {
  const result = await connection.send<{ browserContextIds?: unknown }>(
    "Target.getBrowserContexts",
  );
  if (!Array.isArray(result.browserContextIds) || result.browserContextIds.length !== 0)
    throw failure();
  const version = await connection.send<{ product?: unknown }>("Browser.getVersion");
  if (
    typeof version.product !== "string" ||
    version.product.split("/").at(-1) !== HEADLESS_SHELL_VERSION
  )
    throw failure();
}
export async function captureHeadlessSessionCookies(
  connection: BrowserCdpConnection,
  source: HeadlessSessionCookies["source"],
): Promise<HeadlessSessionCookies> {
  try {
    await requireDedicatedDefaultContext(connection);
    const result = await connection.send<{ cookies?: unknown }>("Storage.getCookies", {});
    if (!Array.isArray(result.cookies) || result.cookies.length > MAX_COOKIES) throw failure();
    const cookies = result.cookies
      .filter((entry) => {
        if (!record(entry) || typeof entry.session !== "boolean") throw failure();
        return entry.session;
      })
      .map((entry) => cookie(entry, true));
    return validateHeadlessSessionCookies({
      schemaVersion: 1,
      shellVersion: HEADLESS_SHELL_VERSION,
      source,
      context: "default",
      cookies,
    });
  } catch {
    throw failure();
  }
}
export async function restoreHeadlessSessionCookies(
  connection: BrowserCdpConnection,
  state: HeadlessSessionCookies,
): Promise<void> {
  try {
    const validated = validateHeadlessSessionCookies(state);
    await requireDedicatedDefaultContext(connection);
    await connection.send("Storage.setCookies", {
      cookies: validated.cookies.map((entry) => {
        const {
          session: _session,
          expires: _expires,
          partitionKeyOpaque: _opaque,
          ...params
        } = entry;
        return params;
      }),
    });
    const actual = await captureHeadlessSessionCookies(connection, validated.source);
    const actualByKey = new Map(actual.cookies.map((entry) => [cookieKey(entry), entry]));
    for (const expected of validated.cookies) {
      // Compare every restorable attribute, including host/domain scope and CHIPS.
      const found = actualByKey.get(cookieKey(expected));
      if (!found || !equalCookie(found, expected)) throw failure();
    }
  } catch {
    throw failure();
  }
}
function equalCookie(left: SessionCookie, right: SessionCookie): boolean {
  const canonical = (value: SessionCookie) =>
    Object.entries(value)
      .filter(([key]) => key !== "partitionKeyOpaque")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, attribute]) =>
        key === "partitionKey"
          ? [
              key,
              [
                attribute && typeof attribute === "object" ? attribute.topLevelSite : null,
                attribute && typeof attribute === "object" ? attribute.hasCrossSiteAncestor : null,
              ],
            ]
          : [key, attribute],
      );
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
