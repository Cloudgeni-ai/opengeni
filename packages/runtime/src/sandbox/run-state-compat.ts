const RUN_STATE_SANDBOX_PROVIDERS = new Set([
  "blaxel",
  "cloudflare",
  "daytona",
  "docker",
  "e2b",
  "local",
  "modal",
  "none",
  "runloop",
  "selfhosted",
  "vercel",
]);

export type RunStateExposedPortsCompatibilityRepair = {
  provider: string;
  sessionClass: "root" | "agent";
  path:
    | "sandbox.sessionState.exposedPorts"
    | "sandbox.sessionsByAgent[*].sessionState.exposedPorts";
};

export type RunStateExposedPortsCompatibilityResult = {
  serializedRunState: string;
  repairs: RunStateExposedPortsCompatibilityRepair[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * RunState owns `exposedPorts` as a port-keyed endpoint record. Provider clients
 * separately own configured/predeclared port arrays in their provider state.
 */
export function runStateExposedPortsRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? structuredClone(value) : undefined;
}

export function runStateCompatibilityProvider(value: unknown): string {
  return typeof value === "string" && RUN_STATE_SANDBOX_PROVIDERS.has(value) ? value : "unknown";
}

function runStateCompatibilityProviderFromEntry(
  sessionState: unknown,
  enclosingBackendId: unknown,
): string {
  const sessionProvider = runStateCompatibilityProvider(
    isRecord(sessionState) ? sessionState.backendId : undefined,
  );
  return sessionProvider === "unknown"
    ? runStateCompatibilityProvider(enclosingBackendId)
    : sessionProvider;
}

function removeInvalidExposedPorts(
  sessionState: unknown,
  repair: RunStateExposedPortsCompatibilityRepair,
  observations: Map<string, RunStateExposedPortsCompatibilityRepair>,
): boolean {
  if (!isRecord(sessionState) || !("exposedPorts" in sessionState)) {
    return false;
  }
  if (runStateExposedPortsRecord(sessionState.exposedPorts)) {
    return false;
  }
  delete sessionState.exposedPorts;
  observations.set(`${repair.provider}:${repair.sessionClass}:${repair.path}`, repair);
  return true;
}

/**
 * Repair only the two SDK-owned RunState sandbox envelope locations. This is a
 * deterministic, path-bounded compatibility transform for historical blobs;
 * providerState (including configuredExposedPorts arrays) and every unrelated
 * RunState field remain untouched.
 */
export function repairSerializedRunStateExposedPorts(
  serializedRunState: string,
): RunStateExposedPortsCompatibilityResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedRunState);
  } catch {
    return { serializedRunState, repairs: [] };
  }
  if (!isRecord(parsed) || !isRecord(parsed.sandbox)) {
    return { serializedRunState, repairs: [] };
  }

  const sandbox = parsed.sandbox;
  const observations = new Map<string, RunStateExposedPortsCompatibilityRepair>();
  let changed = removeInvalidExposedPorts(
    sandbox.sessionState,
    {
      provider: runStateCompatibilityProviderFromEntry(sandbox.sessionState, sandbox.backendId),
      sessionClass: "root",
      path: "sandbox.sessionState.exposedPorts",
    },
    observations,
  );

  if (isRecord(sandbox.sessionsByAgent)) {
    for (const entry of Object.values(sandbox.sessionsByAgent)) {
      if (!isRecord(entry)) continue;
      changed =
        removeInvalidExposedPorts(
          entry.sessionState,
          {
            provider: runStateCompatibilityProviderFromEntry(entry.sessionState, entry.backendId),
            sessionClass: "agent",
            path: "sandbox.sessionsByAgent[*].sessionState.exposedPorts",
          },
          observations,
        ) || changed;
    }
  }

  return changed
    ? { serializedRunState: JSON.stringify(parsed), repairs: [...observations.values()] }
    : { serializedRunState, repairs: [] };
}
