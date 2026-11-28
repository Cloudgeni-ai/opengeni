// Content-free projection of PostHog `$exception` events. It runs in the
// browser, inside the PostHog `before_send` hook, so nothing it removes ever
// leaves the page. What remains locates a failure in code: the exception type,
// the mechanism (handled, autocaptured or not), the stack frames as file,
// function, line and column, the severity and the bundle revision. Error
// message text, source context lines, frame variables, exception steps and
// any URL query, fragment or page address are removed, because they can quote
// what the person typed or saw. PostHog groups issues server-side from the
// type and frames, which are kept, so grouping does not depend on a message.

/** What a scrubbed exception says instead of its message. */
export const REDACTED_EXCEPTION_MESSAGE = "[redacted]";

/** Where the app reported a caught exception from. Closed set. */
export const EXCEPTION_SOURCES = ["react_boundary"] as const;
export type ExceptionSource = (typeof EXCEPTION_SOURCES)[number];

const MAX_EXCEPTIONS = 10;
const MAX_FRAMES = 64;
const SEVERITY_LEVELS = new Set(["fatal", "error", "warning", "log", "info", "debug"]);
const PLATFORMS = new Set(["web:javascript", "node:javascript", "hermes"]);
// Constructor names such as `TypeError`, `DOMException` or `NotAllowedError`.
const SAFE_TYPE = /^[A-Za-z_$][\w$.]{0,99}$/u;
// Engine-rendered function names: `Object.render`, `async Promise.all`,
// `new Foo`, `<anonymous>`, Firefox's `foo/bar<`.
const SAFE_FUNCTION = /^[\w$.<>/[\] -]{1,200}$/u;
const SAFE_TOKEN = /^[\w.:-]{1,100}$/u;
// SDK mechanism names: `generic`, `onerror`, `onunhandledrejection`.
const MECHANISM_TYPE = /^[a-z][a-z_]{0,39}$/u;
// Script resources. Any other path (an inline script reports the page URL)
// is a page address, which can carry private keys such as share links.
const SCRIPT_PATH = /\.(?:m?js|cjs|jsx|tsx?|wasm)$/iu;
// Location strings that are not URLs: `<anonymous>`, `native`, `[native code]`.
const SAFE_PSEUDO_LOCATION = /^[\w$.<>[\] -]{1,100}$/u;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function matching(value: unknown, pattern: RegExp): string | undefined {
  return typeof value === "string" && pattern.test(value) ? value : undefined;
}

/**
 * A script location without query, fragment, credentials or page address.
 * `data:` URLs carry their content inline and keep only the scheme; `blob:`
 * URLs keep only their origin.
 */
export function safeScriptLocation(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (/^data:/iu.test(value)) return "data:";
  if (/^blob:/iu.test(value)) {
    const origin = urlOrigin(value.slice("blob:".length));
    return origin ? `blob:${origin}` : "blob:";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return SAFE_PSEUDO_LOCATION.test(value) ? value : undefined;
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return SCRIPT_PATH.test(url.pathname) ? `${url.origin}${url.pathname}` : `${url.origin}/<page>`;
  }
  // Extension and engine schemes (`chrome-extension:`, `webkit-masked-url:`).
  const scheme = url.protocol.replace(/:$/u, "");
  if (!/^[a-z][a-z0-9+.-]{0,40}$/u.test(scheme)) return undefined;
  const host = /^[\w.-]{0,100}$/u.test(url.host) ? url.host : "";
  return SCRIPT_PATH.test(url.pathname) && /^[\w./-]{1,300}$/u.test(url.pathname)
    ? `${scheme}://${host}${url.pathname}`
    : `${scheme}://${host}`;
}

function urlOrigin(value: string): string | undefined {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

function scrubFrame(frame: unknown): Json | null {
  if (!isRecord(frame)) return null;
  const safe: Json = {};
  const platform = typeof frame.platform === "string" ? frame.platform : undefined;
  safe.platform = platform && PLATFORMS.has(platform) ? platform : "web:javascript";
  const filename = safeScriptLocation(frame.filename);
  if (filename) safe.filename = filename;
  const absPath = safeScriptLocation(frame.abs_path);
  if (absPath) safe.abs_path = absPath;
  const fn = matching(frame.function, SAFE_FUNCTION);
  if (fn) safe.function = fn;
  const lineno = safeInteger(frame.lineno);
  if (lineno !== undefined) safe.lineno = lineno;
  const colno = safeInteger(frame.colno);
  if (colno !== undefined) safe.colno = colno;
  if (typeof frame.in_app === "boolean") safe.in_app = frame.in_app;
  const chunkId = matching(frame.chunk_id, SAFE_TOKEN);
  if (chunkId) safe.chunk_id = chunkId;
  // Never kept: context_line, pre_context, post_context (source text), vars
  // (runtime values), module and instruction addresses.
  return safe;
}

function scrubMechanism(mechanism: unknown): Json | undefined {
  if (!isRecord(mechanism)) return undefined;
  const safe: Json = {};
  if (typeof mechanism.handled === "boolean") safe.handled = mechanism.handled;
  if (typeof mechanism.synthetic === "boolean") safe.synthetic = mechanism.synthetic;
  const type = matching(mechanism.type, MECHANISM_TYPE);
  if (type) safe.type = type;
  // `source` is not kept: it can name a value the error was raised from.
  const exceptionId = safeInteger(mechanism.exception_id);
  if (exceptionId !== undefined) safe.exception_id = exceptionId;
  const parentId = safeInteger(mechanism.parent_id);
  if (parentId !== undefined) safe.parent_id = parentId;
  return safe;
}

/** The type a scrubbed exception reports: a constructor-like name, or `Error`. */
export function safeExceptionType(value: unknown): string {
  return matching(value, SAFE_TYPE) ?? "Error";
}

function scrubException(exception: unknown): Json | null {
  if (!isRecord(exception)) return null;
  const safe: Json = {
    type: safeExceptionType(exception.type),
    value: REDACTED_EXCEPTION_MESSAGE,
  };
  const mechanism = scrubMechanism(exception.mechanism);
  if (mechanism) safe.mechanism = mechanism;
  const stacktrace = exception.stacktrace;
  if (isRecord(stacktrace) && Array.isArray(stacktrace.frames)) {
    // PostHog lists frames oldest first; the newest, closest to the throw,
    // are at the end and are the ones kept.
    const frames = stacktrace.frames
      .slice(-MAX_FRAMES)
      .map(scrubFrame)
      .filter((frame): frame is Json => frame !== null);
    safe.stacktrace = { type: "raw", frames };
  }
  return safe;
}

/** First exception's type and message, for drop decisions made before scrubbing. */
export function leadingException(
  properties: Json | undefined,
): { name?: string; message?: string } | null {
  const list = properties?.$exception_list;
  if (!Array.isArray(list) || !isRecord(list[0])) return null;
  const { type, value } = list[0];
  return {
    ...(typeof type === "string" ? { name: type } : {}),
    ...(typeof value === "string" ? { message: value } : {}),
  };
}

/**
 * Replace every exception-specific property of a `$exception` event with its
 * content-free projection. Other properties pass through unchanged; the
 * analytics boundary's general projection removes URLs from those. Returns
 * null, so the event is dropped, when no exception remains.
 */
export function scrubPosthogExceptionProperties(
  properties: Json,
  context: { revision: string },
): Json | null {
  const list = Array.isArray(properties.$exception_list) ? properties.$exception_list : [];
  const exceptions = list
    .slice(0, MAX_EXCEPTIONS)
    .map(scrubException)
    .filter((exception): exception is Json => exception !== null);
  if (exceptions.length === 0) return null;
  const safe: Json = {};
  for (const [key, value] of Object.entries(properties)) {
    // Message text ($exception_message, $exception_values), buffered steps,
    // client fingerprints and any other exception detail the SDK adds later.
    if (key.startsWith("$exception_") || key === "exception_source") continue;
    safe[key] = value;
  }
  safe.$exception_list = exceptions;
  safe.$exception_types = exceptions.map((exception) => exception.type);
  const level = properties.$exception_level;
  if (typeof level === "string" && SEVERITY_LEVELS.has(level)) safe.$exception_level = level;
  const source = properties.exception_source;
  if ((EXCEPTION_SOURCES as readonly unknown[]).includes(source)) safe.exception_source = source;
  safe.opengeni_revision = context.revision;
  return safe;
}
