export function publicEndpointOrigin(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "[unsupported endpoint]";
    return url.origin;
  } catch {
    return "[invalid endpoint]";
  }
}

export function publicProbeErrorDiagnostic(error: unknown): string {
  const rawName = error instanceof Error ? error.name : "Error";
  const name = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(rawName) ? rawName : "Error";
  const metadata: string[] = [name];
  if (error && typeof error === "object") {
    const status = Number(
      (error as { status?: unknown; statusCode?: unknown }).status ??
        (error as { statusCode?: unknown }).statusCode,
    );
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
      metadata.push(`status=${status}`);
    }
    const rawCode = (error as { code?: unknown }).code;
    if (typeof rawCode === "string" || typeof rawCode === "number") {
      const code = String(rawCode);
      if (/^[A-Za-z0-9_.:-]{1,80}$/.test(code)) metadata.push(`code=${code}`);
    }
  }
  return metadata.join(" ");
}

/** Parse a dial target without returning credentials, paths, or query strings
 * in public diagnostics. Bare IPv6 addresses must use bracket notation. */
export function probeHostPort(
  value: string,
  defaultPort: number,
): { host: string; port: number } | null {
  try {
    const url = new URL(value.includes("://") ? value : `tcp://${value}`);
    const port = Number(url.port || defaultPort);
    let host = url.hostname;
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { host, port };
  } catch {
    return null;
  }
}
