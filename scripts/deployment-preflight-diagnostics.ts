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
