type ProviderOperationGate = {
  activeOperations: number;
  captureActive: boolean;
  operationWaiters: Array<() => void>;
  captureWaiters: Array<() => void>;
};

const providerOperationGates = new WeakMap<object, ProviderOperationGate>();

function sessionIdentity(session: unknown): object {
  const identityType = typeof session;
  if (!["object", "function"].includes(identityType) || session === null) {
    throw new Error("Sandbox provider operation has no session identity");
  }
  return session as object;
}

function gateFor(session: object): ProviderOperationGate {
  const existing = providerOperationGates.get(session);
  if (existing) return existing;
  const created: ProviderOperationGate = {
    activeOperations: 0,
    captureActive: false,
    operationWaiters: [],
    captureWaiters: [],
  };
  providerOperationGates.set(session, created);
  return created;
}

async function enterOperation(gate: ProviderOperationGate): Promise<boolean> {
  if (!gate.captureActive && gate.captureWaiters.length === 0) {
    gate.activeOperations += 1;
    return false;
  }
  await new Promise<void>((resolve) => gate.operationWaiters.push(resolve));
  return true;
}

function leaveOperation(gate: ProviderOperationGate): void {
  gate.activeOperations -= 1;
  if (gate.activeOperations < 0) {
    throw new Error("Sandbox provider operation gate underflow");
  }
  if (gate.activeOperations === 0) {
    const nextCapture = gate.captureWaiters.shift();
    if (nextCapture) {
      gate.captureActive = true;
      nextCapture();
    }
  }
}

async function enterCapture(gate: ProviderOperationGate, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!gate.captureActive && gate.activeOperations === 0) {
    gate.captureActive = true;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const admit = () => {
      signal?.removeEventListener("abort", abandon);
      resolve();
    };
    // An abandoned waiter never held the gate. Remove it, and when it was the
    // only queued capture let the operations it was holding back proceed.
    const abandon = () => {
      const index = gate.captureWaiters.indexOf(admit);
      if (index < 0) return;
      gate.captureWaiters.splice(index, 1);
      if (!gate.captureActive && gate.captureWaiters.length === 0) {
        const operations = gate.operationWaiters.splice(0);
        gate.activeOperations += operations.length;
        for (const operation of operations) operation();
      }
      reject(signal!.reason);
    };
    gate.captureWaiters.push(admit);
    signal?.addEventListener("abort", abandon, { once: true });
  });
}

function leaveCapture(gate: ProviderOperationGate): void {
  if (!gate.captureActive) {
    throw new Error("Sandbox provider capture gate was not held");
  }
  const nextCapture = gate.captureWaiters.shift();
  if (nextCapture) {
    nextCapture();
    return;
  }
  gate.captureActive = false;
  const operations = gate.operationWaiters.splice(0);
  gate.activeOperations += operations.length;
  for (const operation of operations) operation();
}

/**
 * Coordinate every command/filesystem/control call against one in-process
 * provider session. Ordinary operations may overlap; once a capture queues,
 * later operations wait until its exclusive provider pause completes.
 */
export async function withSandboxProviderOperation<T>(
  session: unknown,
  operation: () => Promise<T>,
  onCaptureWait?: (observation: { durationMs: number; outcome: "completed" }) => void,
): Promise<T> {
  const gate = gateFor(sessionIdentity(session));
  const waitStartedAt = performance.now();
  const waitedForCapture = await enterOperation(gate);
  if (waitedForCapture && onCaptureWait) {
    try {
      onCaptureWait({
        durationMs: Math.max(0, performance.now() - waitStartedAt),
        outcome: "completed",
      });
    } catch {
      // Diagnostics must never alter provider-operation ordering.
    }
  }
  try {
    return await operation();
  } finally {
    leaveOperation(gate);
  }
}

/**
 * Hold the provider session exclusively for the complete verified archive
 * capture. The durable lease claim handles other workers; this local gate
 * closes the same-holder race between native reads and the heartbeat capture.
 * An aborted signal abandons a capture still queued behind operations; it never
 * interrupts a capture that already holds the gate (the capture owns that).
 */
export async function withSandboxProviderCapture<T>(
  session: unknown,
  capture: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const gate = gateFor(sessionIdentity(session));
  await enterCapture(gate, signal);
  try {
    return await capture();
  } finally {
    leaveCapture(gate);
  }
}
