/**
 * Host-native Connected Machine workspace paths.
 *
 * The connected agent reports its launch root in Hello. OpenGeni persists that
 * value and uses it as the manifest/session root; there is no virtual alias and
 * no command rewriting. Relative paths resolve lexically from that root while
 * absolute paths retain their host meaning.
 */

export type ConnectedMachineOs = "linux" | "macos" | "windows";

const MAX_MACHINE_PATH_LENGTH = 4_096;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:\//u;
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:(?!\/)/u;
const WINDOWS_UNC_ABSOLUTE = /^\/\/[^/]+\/[^/]+(?:\/|$)/u;

function assertPathText(value: string, label: string): void {
  if (value.length === 0 || value.length > MAX_MACHINE_PATH_LENGTH) {
    throw new TypeError(`${label} must contain between 1 and 4096 characters`);
  }
  if (CONTROL_CHARACTER.test(value)) {
    throw new TypeError(`${label} must not contain control characters`);
  }
  if (value !== value.trim()) {
    throw new TypeError(`${label} must not start or end with whitespace`);
  }
}

function normalizeSegments(segments: readonly string[], absoluteFloor: number): string[] {
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length > absoluteFloor) normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized;
}

function normalizePosixAbsolutePath(value: string): string {
  if (!value.startsWith("/")) {
    throw new TypeError(`Connected Machine workspace root "${value}" must be absolute`);
  }
  if (value.includes("\\")) {
    throw new TypeError(
      `Connected Machine POSIX workspace root "${value}" must use "/" separators`,
    );
  }
  const normalized = normalizeSegments(value.split("/"), 0).join("/");
  return normalized ? `/${normalized}` : "/";
}

function normalizeWindowsAbsolutePath(value: string): string {
  const portable = value.replaceAll("\\", "/");
  const lower = portable.toLowerCase();
  if (lower.startsWith("//?/") || lower.startsWith("//./")) {
    throw new TypeError("Connected Machine device-namespace paths are not supported");
  }
  if (WINDOWS_DRIVE_ABSOLUTE.test(portable)) {
    const prefix = `${portable[0]!.toUpperCase()}:/`;
    const normalized = normalizeSegments(portable.slice(3).split("/"), 0).join("/");
    return normalized ? `${prefix}${normalized}` : prefix;
  }
  if (WINDOWS_UNC_ABSOLUTE.test(portable)) {
    const segments = portable.slice(2).split("/").filter(Boolean);
    const [server, share, ...rest] = segments;
    const normalized = normalizeSegments(rest, 0).join("/");
    return `//${server}/${share}${normalized ? `/${normalized}` : ""}`;
  }
  throw new TypeError(`Connected Machine Windows workspace root "${value}" must be absolute`);
}

export function normalizeConnectedMachineWorkspaceRoot(
  value: string,
  os: ConnectedMachineOs,
): string {
  assertPathText(value, "Connected Machine workspace root");
  return os === "windows" ? normalizeWindowsAbsolutePath(value) : normalizePosixAbsolutePath(value);
}

export function isWindowsConnectedMachinePath(value: string): boolean {
  const portable = value.replaceAll("\\", "/");
  return WINDOWS_DRIVE_ABSOLUTE.test(portable) || WINDOWS_UNC_ABSOLUTE.test(portable);
}

export function isConnectedMachineAbsolutePath(value: string): boolean {
  const portable = value.replaceAll("\\", "/");
  return (
    portable.startsWith("/") ||
    WINDOWS_DRIVE_ABSOLUTE.test(portable) ||
    WINDOWS_UNC_ABSOLUTE.test(portable)
  );
}

export function connectedMachineWorkspaceRootsEqual(left: string, right: string): boolean {
  if (isWindowsConnectedMachinePath(left) || isWindowsConnectedMachinePath(right)) {
    return left.replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase();
  }
  return left === right;
}

/** True only when an absolute host-native path stays beneath an already-
 * normalized absolute workspace root. Windows drive and UNC comparisons are
 * case-insensitive; POSIX comparisons remain byte-sensitive. */
export function connectedMachinePathWithinRoot(workspaceRoot: string, value: string): boolean {
  if (!isConnectedMachineAbsolutePath(value)) return false;
  let path: string;
  try {
    path = resolveConnectedMachinePath(workspaceRoot, value);
  } catch {
    return false;
  }
  const windows = isWindowsConnectedMachinePath(workspaceRoot);
  if (windows !== isWindowsConnectedMachinePath(path)) return false;
  const comparisonRoot = windows ? workspaceRoot.toLowerCase() : workspaceRoot;
  const comparisonPath = windows ? path.toLowerCase() : path;
  const rootPrefix = comparisonRoot.endsWith("/") ? comparisonRoot : `${comparisonRoot}/`;
  return comparisonPath === comparisonRoot || comparisonPath.startsWith(rootPrefix);
}

/** Return the portable slash-separated path relative to workspaceRoot, or null
 * when the absolute candidate is outside that authority. */
export function relativeConnectedMachinePath(workspaceRoot: string, value: string): string | null {
  if (!connectedMachinePathWithinRoot(workspaceRoot, value)) return null;
  const path = resolveConnectedMachinePath(workspaceRoot, value);
  if (connectedMachineWorkspaceRootsEqual(path, workspaceRoot)) return "";
  return path.slice(workspaceRoot.endsWith("/") ? workspaceRoot.length : workspaceRoot.length + 1);
}

function normalizeAbsoluteOperationPath(value: string, windows: boolean): string {
  if (windows) {
    const portable = value.replaceAll("\\", "/");
    if (WINDOWS_DRIVE_RELATIVE.test(portable)) {
      throw new TypeError(
        `Windows drive-relative path "${value}" is ambiguous; use an absolute path`,
      );
    }
    if (WINDOWS_DRIVE_ABSOLUTE.test(portable) || WINDOWS_UNC_ABSOLUTE.test(portable)) {
      return normalizeWindowsAbsolutePath(portable);
    }
    // A leading slash is a real Windows rooted path on the current drive. Keep
    // it literal instead of treating it as a workspace-relative alias.
    if (portable.startsWith("/")) return normalizePosixAbsolutePath(portable);
    throw new TypeError(`Connected Machine path "${value}" is not absolute`);
  }
  return normalizePosixAbsolutePath(value);
}

/** Resolve one operation path against an already-normalized absolute root. */
export function resolveConnectedMachinePath(
  workspaceRoot: string,
  value: string | undefined,
): string {
  const path = value ?? "";
  if (CONTROL_CHARACTER.test(path) || path.length > MAX_MACHINE_PATH_LENGTH) {
    throw new TypeError("Connected Machine path is invalid");
  }
  const windows = isWindowsConnectedMachinePath(workspaceRoot);
  const portable = windows ? path.replaceAll("\\", "/") : path;
  if (WINDOWS_DRIVE_RELATIVE.test(portable)) {
    throw new TypeError(`Windows drive-relative path "${path}" is ambiguous; use an absolute path`);
  }
  if (
    portable.startsWith("/") ||
    WINDOWS_DRIVE_ABSOLUTE.test(portable) ||
    WINDOWS_UNC_ABSOLUTE.test(portable)
  ) {
    return normalizeAbsoluteOperationPath(portable, windows);
  }
  const relative = portable || ".";
  const joined = `${workspaceRoot.replace(/\/+$/u, "")}/${relative}`;
  return windows ? normalizeWindowsAbsolutePath(joined) : normalizePosixAbsolutePath(joined);
}

/** Resolve a configured session cwd. Tilde is intentionally not guessed: the
 * server has a launch root, not an authenticated service-user home directory. */
export function resolveConnectedMachineWorkspaceRoot(
  reportedRoot: string,
  configuredWorkingDir: string | null | undefined,
): string {
  if (!configuredWorkingDir) return reportedRoot;
  if (configuredWorkingDir === "~" || configuredWorkingDir.startsWith("~/")) {
    throw new TypeError(
      'Connected Machine working directory must be absolute or relative to the reported workspace root; "~" is not supported',
    );
  }
  return resolveConnectedMachinePath(reportedRoot, configuredWorkingDir);
}
