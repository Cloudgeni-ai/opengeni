import {
  CredentialProviderMcpMaterial,
  normalizeCredentialProviderMcpUrl,
  type McpServerConnectionRef,
} from "@opengeni/contracts";

export type RunMcpCredentialTarget = {
  id: string;
  url: string;
  connectionRef?: McpServerConnectionRef | undefined;
};
export type RunMcpCredentialMaterial = {
  mcp?: CredentialProviderMcpMaterial;
  expiresAt: Date | null;
};

export class RunMcpCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunMcpCredentialError";
  }
}

/** Never lets a hostile thrown value (e.g. a trapping Proxy) replace the source failure. */
export function isRunMcpCredentialError(error: unknown): error is RunMcpCredentialError {
  try {
    return error instanceof RunMcpCredentialError;
  } catch {
    return false;
  }
}

/**
 * Attempt-local secrets only. Nothing from this controller enters a server
 * configuration, tool catalog, model input, or persisted event.
 */
export class RunMcpCredentials {
  #entries = new Map<string, { headers: Record<string, string>; expiresAt: number | null }>();
  #managed = new Set<string>();
  readonly #targets: readonly RunMcpCredentialTarget[];
  readonly #signal: AbortSignal | undefined;
  #remoteTargets: readonly RunMcpCredentialTarget[] | undefined;
  readonly #now: () => number;
  #closed = false;
  readonly #onAbort = () => this.close();

  constructor(
    targets: readonly RunMcpCredentialTarget[],
    options: { signal?: AbortSignal; now?: () => number } = {},
  ) {
    this.#targets = targets
      .filter((target) => !target.connectionRef)
      .map(({ id, url }) => ({ id, url }));
    this.#signal = options.signal;
    this.#now = options.now ?? Date.now;
    this.#signal?.addEventListener("abort", this.#onAbort, { once: true });
  }

  close(): void {
    this.#closed = true;
    this.#entries.clear();
    this.#managed.clear();
    this.#signal?.removeEventListener("abort", this.#onAbort);
  }

  #assertOpen(): void {
    this.#signal?.throwIfAborted();
    if (this.#closed) throw new RunMcpCredentialError("Run MCP credential attempt is closed");
  }

  /** Validate a complete replacement before changing any live request headers. */
  prepare(material: RunMcpCredentialMaterial | null): () => void {
    this.#assertOpen();
    const next = new Map<string, { headers: Record<string, string>; expiresAt: number | null }>();
    const parsed = CredentialProviderMcpMaterial.safeParse(
      material?.mcp === undefined ? [] : material.mcp,
    );
    if (!parsed.success) {
      throw new RunMcpCredentialError("Run MCP credential material is invalid");
    }
    let skipped = 0;
    const retained = new Set<string>();
    const managed = new Set<string>();
    for (const entry of parsed.data) {
      const matches = (this.#remoteTargets ?? this.#targets).filter(
        (target) => normalizedUrl(target.url) === entry.url,
      );
      if (
        matches.length !== 1 ||
        parsed.data.filter((candidate) => candidate.url === entry.url).length !== 1
      ) {
        skipped += 1;
        continue;
      }
      const id = matches[0]!.id;
      managed.add(id);
      if (next.has(id)) {
        skipped += 1;
        next.delete(id);
        continue;
      }
      const expiry = entry.expiresAt ? Date.parse(entry.expiresAt) : null;
      const expiresAt =
        expiry === null
          ? (material?.expiresAt?.getTime() ?? null)
          : Math.min(expiry, material?.expiresAt?.getTime() ?? Infinity);
      if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= this.#now())) {
        skipped += 1;
        retained.add(id);
        continue;
      }
      next.set(id, { headers: { ...entry.headers }, expiresAt });
    }
    return () => {
      this.#assertOpen();
      // Tool construction can exclude a local route while a sandbox write is
      // pending. Recheck the narrowed transport set at the atomic commit too.
      for (const id of next.keys()) {
        if (this.#remoteTargets && !this.#remoteTargets.some((target) => target.id === id)) {
          next.delete(id);
          skipped += 1;
        }
      }
      // Skipping one target must not disable valid siblings, and retained
      // material still fails closed at its original expiry.
      if (skipped) {
        for (const [id, entry] of this.#entries) {
          if (!next.has(id) && (retained.has(id) || !managed.has(id))) next.set(id, entry);
        }
      }
      this.#entries = next;
      for (const id of managed) {
        if (!this.#remoteTargets || this.#remoteTargets.some((target) => target.id === id)) {
          this.#managed.add(id);
        }
      }
      this.#warnSkipped(skipped);
    };
  }

  replace(material: RunMcpCredentialMaterial | null): void {
    this.prepare(material)();
  }

  /** Refuse credentials for native, omitted, local, or rewritten server routes. */
  assertRemoteTargets(targets: readonly RunMcpCredentialTarget[]): void {
    this.#remoteTargets = this.#targets.filter((original) =>
      targets.some(
        (target) =>
          !target.connectionRef &&
          target.id === original.id &&
          normalizedUrl(target.url) !== null &&
          normalizedUrl(target.url) === normalizedUrl(original.url),
      ),
    );
    this.#dropExcluded();
  }

  excludeLocalTarget(id: string): void {
    this.#remoteTargets = (this.#remoteTargets ?? this.#targets).filter(
      (target) => target.id !== id,
    );
    this.#dropExcluded();
  }

  #dropExcluded(): void {
    let skipped = 0;
    for (const id of this.#managed) {
      if (!this.#remoteTargets?.some((target) => target.id === id)) {
        this.#entries.delete(id);
        this.#managed.delete(id);
        skipped += 1;
      }
    }
    this.#warnSkipped(skipped);
  }

  #warnSkipped(count: number): void {
    if (!count) return;
    console.warn("Run MCP credential entries skipped", {
      reason: "unmatched_or_unselected_or_ambiguous_or_local_target",
      count,
    });
  }

  has(id: string): boolean {
    return this.#managed.has(id);
  }

  assertAvailable(id: string): void {
    this.#assertOpen();
    if (!this.#managed.has(id)) return;
    const entry = this.#entries.get(id);
    if (!entry || (entry.expiresAt !== null && entry.expiresAt <= this.#now())) {
      throw new RunMcpCredentialError("MCP authentication unavailable: provider renewal required");
    }
  }

  /** Called at the literal fetch boundary, including POST, SSE GET and DELETE. */
  requestInit(
    target: RunMcpCredentialTarget,
    input: string | URL | Request,
    init?: RequestInit,
  ): RequestInit | undefined {
    this.#assertOpen();
    // Native connection authority and attribution own all authentication on
    // this route. Even a stale or manually supplied provider grant must never
    // replace its bearer or inject alternate authentication headers.
    if (target.connectionRef) {
      this.excludeLocalTarget(target.id);
      return init;
    }
    this.assertAvailable(target.id);
    const entry = this.#entries.get(target.id);
    if (!entry) return init;
    const destination = input instanceof Request ? input.url : String(input);
    const original = (this.#remoteTargets ?? this.#targets).find(
      (candidate) => candidate.id === target.id,
    );
    if (
      !original ||
      normalizedUrl(destination) !== normalizedUrl(original.url) ||
      normalizedUrl(target.url) !== normalizedUrl(original.url)
    ) {
      throw new RunMcpCredentialError("Run MCP credential request destination changed");
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    for (const [name, value] of Object.entries(entry.headers)) headers.set(name, value);
    return {
      ...init,
      headers,
      ...(this.#signal
        ? {
            signal: init?.signal ? AbortSignal.any([this.#signal, init.signal]) : this.#signal,
          }
        : {}),
    };
  }
}

function normalizedUrl(value: string): string | null {
  try {
    return normalizeCredentialProviderMcpUrl(value);
  } catch {
    return null;
  }
}
