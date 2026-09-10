export type BootstrapErrorContext = "client_configuration" | "workspace_access";

export type BootstrapErrorPresentation = Readonly<{
  title: string;
  description: string;
}>;

type ErrorMetadata = {
  status: number | null;
  code: string | null;
  body: string | null;
};

const maintenancePresentation: BootstrapErrorPresentation = {
  title: "OpenGeni is under maintenance",
  description: "We'll be back shortly. Try again in a moment.",
};

const temporaryUnavailablePresentation: BootstrapErrorPresentation = {
  title: "OpenGeni is temporarily unavailable",
  description: "The service could not finish loading. Try again shortly.",
};

const networkUnavailablePresentation: BootstrapErrorPresentation = {
  title: "OpenGeni is unreachable",
  description: "The app could not reach the OpenGeni API. Check your connection and try again.",
};

const invalidConfigurationResponsePresentation: BootstrapErrorPresentation = {
  title: "OpenGeni couldn't start",
  description:
    "The API returned an invalid configuration response. Check the deployment or proxy configuration, then try again.",
};

const clientConfigurationPresentation: BootstrapErrorPresentation = {
  title: "OpenGeni couldn't start",
  description:
    "The client configuration could not be loaded. Check the deployment settings and server logs, then try again.",
};

const workspaceAccessPresentation: BootstrapErrorPresentation = {
  title: "Workspace access unavailable",
  description: "OpenGeni couldn't load your workspace access. Try again.",
};

function normalizedErrorCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
  return normalized || null;
}

function isMaintenanceCode(value: unknown): boolean {
  const normalized = normalizedErrorCode(value);
  return normalized === "maintenance" || normalized === "maintenance_mode";
}

function payloadIndicatesMaintenance(value: unknown, depth = 0): boolean {
  if (depth > 2) return false;
  if (typeof value === "string") return isMaintenanceCode(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    isMaintenanceCode(record.code) ||
    isMaintenanceCode(record.type) ||
    payloadIndicatesMaintenance(record.error, depth + 1)
  );
}

function bodyIndicatesMaintenance(body: string | null): boolean {
  if (!body || body.length > 4_096) return false;
  if (isMaintenanceCode(body)) return true;
  try {
    return payloadIndicatesMaintenance(JSON.parse(body));
  } catch {
    return false;
  }
}

function errorMetadata(error: unknown): ErrorMetadata {
  if (!error || typeof error !== "object") {
    return { status: null, code: null, body: null };
  }
  const candidate = error as Record<string, unknown>;
  return {
    status: typeof candidate.status === "number" ? candidate.status : null,
    code: typeof candidate.code === "string" ? candidate.code : null,
    body: typeof candidate.body === "string" ? candidate.body : null,
  };
}

/**
 * Bootstrap failures replace the whole application surface, so they should
 * explain the recovery path without exposing API JSON, proxy HTML, or internal
 * configuration details as page copy.
 */
export function bootstrapErrorPresentation(
  error: unknown,
  context: BootstrapErrorContext,
): BootstrapErrorPresentation {
  const metadata = errorMetadata(error);
  if (isMaintenanceCode(metadata.code) || bodyIndicatesMaintenance(metadata.body)) {
    return maintenancePresentation;
  }
  if (
    metadata.status === 0 ||
    normalizedErrorCode(metadata.code) === "network_error" ||
    error instanceof TypeError
  ) {
    return networkUnavailablePresentation;
  }
  if (error instanceof SyntaxError) {
    return context === "client_configuration"
      ? invalidConfigurationResponsePresentation
      : workspaceAccessPresentation;
  }
  if (metadata.status !== null && metadata.status >= 502 && metadata.status <= 504) {
    return temporaryUnavailablePresentation;
  }
  if (context === "client_configuration") {
    return clientConfigurationPresentation;
  }
  if (metadata.status !== null && metadata.status >= 500) {
    return temporaryUnavailablePresentation;
  }
  return workspaceAccessPresentation;
}
