import { closeQualifiedModalNativeBrokerSession } from "@opengeni/core";
import type { EstablishedSandboxSession } from "@opengeni/runtime/sandbox";

type Entry = {
  promise: Promise<EstablishedSandboxSession>;
  borrowers: number;
  retired: boolean;
  timer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
};

const releases = new WeakMap<EstablishedSandboxSession, () => Promise<void>>();

/** Release this request's borrow, not another request's identical SDK wrapper.
 * Uncached wrappers use only the explicitly installed host-only broker close;
 * the legacy SDK close is never a local-resource disposal operation. */
export async function releaseSandboxHostHandle(handle?: EstablishedSandboxSession) {
  if (!handle) return;
  const release = releases.get(handle);
  if (release) await release();
  else await closeQualifiedModalNativeBrokerSession(handle.session);
}

/** Bounded exact-lease cache with separate cache and request ownership. Eviction
 * prevents new borrows immediately, but closes only after every old borrower
 * leaves. Each borrow has its own idempotent token while retaining the original
 * SDK session identity (including legacy process maps and snapshot wrappers). */
export class SandboxHostHandleCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly idleMs: number,
    private readonly maxEntries: number,
    private readonly dispose: (handle: EstablishedSandboxSession) => Promise<void> = async (
      handle,
    ) => await closeQualifiedModalNativeBrokerSession(handle.session),
  ) {
    if (!Number.isFinite(idleMs) || idleMs <= 0 || !Number.isInteger(maxEntries) || maxEntries < 1)
      throw new Error("Invalid sandbox host handle cache bounds");
  }

  private close(entry: Entry): Promise<void> {
    if (!entry.retired || entry.borrowers !== 0) return Promise.resolve();
    return (entry.closing ??= (async () => {
      let handle: EstablishedSandboxSession;
      try {
        handle = await entry.promise;
      } catch {
        // Failed establishment owns its own partial-construction cleanup.
        return;
      }
      await this.dispose(handle);
    })());
  }

  evict(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    entry.retired = true;
    clearTimeout(entry.timer);
    // The physical registry retains failed-join quarantine. No retry, terminate,
    // or authorization change is implied by this bounded host-cache disposal.
    void this.close(entry).catch(() => console.error("Sandbox host handle disposal failed"));
  }

  private arm(key: string, entry: Entry) {
    clearTimeout(entry.timer);
    if (entry.retired || entry.borrowers !== 0) return;
    entry.timer = setTimeout(() => {
      if (this.entries.get(key) === entry) this.evict(key);
    }, this.idleMs);
    entry.timer.unref?.();
  }

  private async borrow(key: string, entry: Entry): Promise<EstablishedSandboxSession> {
    entry.borrowers++;
    clearTimeout(entry.timer);
    let done: Promise<void> | undefined;
    const release = () =>
      (done ??= (async () => {
        entry.borrowers--;
        this.arm(key, entry);
        await this.close(entry);
      })());
    try {
      const handle = { ...(await entry.promise) };
      releases.set(handle, release);
      return handle;
    } catch (error) {
      if (this.entries.get(key) === entry) this.evict(key);
      await release();
      throw error;
    }
  }

  async acquire(key: string, establish: () => Promise<EstablishedSandboxSession>) {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        promise: Promise.resolve().then(establish),
        borrowers: 0,
        retired: false,
      };
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    const borrowed = this.borrow(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.evict(oldest);
    }
    return await borrowed;
  }

  /** Transfer an uncached freshly created wrapper to the cache and return one
   * caller borrow. The input must not itself be a borrowed cache handle. */
  async remember(key: string, handle: EstablishedSandboxSession) {
    if (releases.has(handle)) throw new Error("Cannot transfer a borrowed sandbox cache handle");
    this.evict(key);
    return await this.acquire(key, async () => handle);
  }
}
