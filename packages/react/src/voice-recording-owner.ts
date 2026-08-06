export const VOICE_RECORDING_OWNER_SESSION_KEY = "opengeni.voice-recording-owner.v1";

const VOICE_RECORDING_OWNER_LOCK_PREFIX = "opengeni.voice-recording-owner:";
const VOICE_RECORDING_OWNER_CHANNEL = "opengeni.voice-recording-owner.v1";
const OWNER_LOCK_RELOAD_GRACE_MILLISECONDS = 250;
const OWNER_LOCK_RELOAD_NAVIGATION_MILLISECONDS = 5_000;
const OWNER_BROADCAST_PROBE_MILLISECONDS = 100;
const OWNER_BROADCAST_RELOAD_ATTEMPTS = 10;

export type VoiceRecordingOwnerLease = {
  ownerId: string;
  release: () => void;
};

type UnderlyingOwnerLease = VoiceRecordingOwnerLease;

type OwnerProbeMessage = {
  type: "voice-recording-owner.probe";
  ownerId: string;
  instanceId: string;
};

type OwnerOccupiedMessage = {
  type: "voice-recording-owner.occupied";
  ownerId: string;
  targetInstanceId: string;
};

let sharedLeasePromise: Promise<UnderlyingOwnerLease> | null = null;
let sharedLeaseConsumers = 0;

/**
 * Acquire one document-scoped owner identity shared by every voice hook in the
 * current document. The session-stored candidate survives reload, while the
 * held lock/handshake prevents opener-created or duplicated tabs from reusing
 * that identity concurrently.
 */
export async function acquireDefaultVoiceRecordingOwnerLease(): Promise<VoiceRecordingOwnerLease> {
  sharedLeaseConsumers += 1;
  sharedLeasePromise ??= createUnderlyingOwnerLease();
  let underlying: UnderlyingOwnerLease;
  try {
    underlying = await sharedLeasePromise;
  } catch (error) {
    sharedLeaseConsumers -= 1;
    if (sharedLeaseConsumers === 0) sharedLeasePromise = null;
    throw error;
  }

  let released = false;
  return {
    ownerId: underlying.ownerId,
    release: () => {
      if (released) return;
      released = true;
      sharedLeaseConsumers = Math.max(0, sharedLeaseConsumers - 1);
      if (sharedLeaseConsumers === 0) {
        sharedLeasePromise = null;
        underlying.release();
      }
    },
  };
}

async function createUnderlyingOwnerLease(): Promise<UnderlyingOwnerLease> {
  const candidate = readSessionOwnerId() ?? crypto.randomUUID();
  const reloadNavigation = isReloadNavigation();

  if (hasWebLocks()) {
    const retained = await tryAcquireWebLock(
      candidate,
      reloadNavigation
        ? OWNER_LOCK_RELOAD_NAVIGATION_MILLISECONDS
        : OWNER_LOCK_RELOAD_GRACE_MILLISECONDS,
    );
    if (retained) {
      writeSessionOwnerId(candidate);
      return retained;
    }

    const rotated = crypto.randomUUID();
    writeSessionOwnerId(rotated);
    const acquired = await tryAcquireWebLock(rotated, OWNER_LOCK_RELOAD_GRACE_MILLISECONDS);
    if (acquired) return acquired;
  }

  const broadcastLease = await tryAcquireBroadcastLease(
    readSessionOwnerId() ?? candidate,
    reloadNavigation ? OWNER_BROADCAST_RELOAD_ATTEMPTS : 0,
  );
  if (broadcastLease) return broadcastLease;

  // Without a cross-document coordination primitive, prefer a fresh
  // per-document identity over copied session state. Recovery then waits only
  // for the ordinary stale-owner timeout instead of risking cross-tab access.
  const ownerId = crypto.randomUUID();
  writeSessionOwnerId(ownerId);
  return { ownerId, release: () => undefined };
}

function hasWebLocks(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.locks !== null &&
    navigator.locks !== undefined &&
    typeof navigator.locks.request === "function"
  );
}

async function tryAcquireWebLock(
  ownerId: string,
  waitMilliseconds: number,
): Promise<UnderlyingOwnerLease | null> {
  if (!hasWebLocks()) return null;

  return await new Promise<UnderlyingOwnerLease | null>((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const settle = (lease: UnderlyingOwnerLease | null) => {
      if (settled) return;
      settled = true;
      resolve(lease);
    };
    const timeout = setTimeout(() => controller.abort(), waitMilliseconds);

    void navigator.locks
      .request(
        `${VOICE_RECORDING_OWNER_LOCK_PREFIX}${ownerId}`,
        { mode: "exclusive", signal: controller.signal },
        async () => {
          clearTimeout(timeout);
          let releaseLock: (() => void) | null = null;
          const held = new Promise<void>((release) => {
            releaseLock = release;
          });
          settle({
            ownerId,
            release: () => releaseLock?.(),
          });
          await held;
        },
      )
      .catch(() => {
        clearTimeout(timeout);
        settle(null);
      });
  });
}

async function tryAcquireBroadcastLease(
  initialOwnerId: string,
  retainCandidateAttempts: number,
): Promise<UnderlyingOwnerLease | null> {
  const BroadcastChannelConstructor =
    typeof window !== "undefined" ? window.BroadcastChannel : undefined;
  if (!BroadcastChannelConstructor) return null;

  let ownerId = initialOwnerId;
  for (let attempt = 0; attempt < retainCandidateAttempts + 3; attempt += 1) {
    const channel = new BroadcastChannelConstructor(VOICE_RECORDING_OWNER_CHANNEL);
    const instanceId = crypto.randomUUID();
    let occupied = false;
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = ownerCoordinationMessage(event.data);
      if (!message || message.ownerId !== ownerId) return;
      if (message.type === "voice-recording-owner.probe") {
        if (message.instanceId === instanceId) return;
        channel.postMessage({
          type: "voice-recording-owner.occupied",
          ownerId,
          targetInstanceId: message.instanceId,
        } satisfies OwnerOccupiedMessage);
        return;
      }
      if (message.targetInstanceId === instanceId) occupied = true;
    };
    channel.addEventListener("message", onMessage);
    channel.postMessage({
      type: "voice-recording-owner.probe",
      ownerId,
      instanceId,
    } satisfies OwnerProbeMessage);
    await delay(OWNER_BROADCAST_PROBE_MILLISECONDS);
    if (!occupied) {
      writeSessionOwnerId(ownerId);
      return {
        ownerId,
        release: () => {
          channel.removeEventListener("message", onMessage);
          channel.close();
        },
      };
    }
    channel.removeEventListener("message", onMessage);
    channel.close();
    if (attempt < retainCandidateAttempts) continue;
    ownerId = crypto.randomUUID();
    writeSessionOwnerId(ownerId);
  }
  return null;
}

function isReloadNavigation(): boolean {
  if (typeof performance === "undefined") return false;
  return performance.getEntriesByType("navigation").some((entry) => {
    return "type" in entry && entry.type === "reload";
  });
}

function ownerCoordinationMessage(value: unknown): OwnerProbeMessage | OwnerOccupiedMessage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type === "voice-recording-owner.probe" &&
    typeof candidate.ownerId === "string" &&
    typeof candidate.instanceId === "string"
  ) {
    return candidate as OwnerProbeMessage;
  }
  if (
    candidate.type === "voice-recording-owner.occupied" &&
    typeof candidate.ownerId === "string" &&
    typeof candidate.targetInstanceId === "string"
  ) {
    return candidate as OwnerOccupiedMessage;
  }
  return null;
}

function readSessionOwnerId(): string | null {
  try {
    return typeof window === "undefined"
      ? null
      : window.sessionStorage.getItem(VOICE_RECORDING_OWNER_SESSION_KEY);
  } catch {
    return null;
  }
}

function writeSessionOwnerId(ownerId: string): void {
  try {
    window.sessionStorage.setItem(VOICE_RECORDING_OWNER_SESSION_KEY, ownerId);
  } catch {
    // Private/embedded contexts may deny session storage. The held lock or
    // broadcast lease still keeps the in-memory identity document-scoped.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
