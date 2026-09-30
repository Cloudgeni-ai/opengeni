import { CredentialProviderMcpMaterial } from "@opengeni/contracts";

export type RunMcpCredentialTarget = { id: string; url: string };
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

/**
 * Attempt-local secrets only. Nothing from this controller enters a server
 * configuration, tool catalog, model input, or persisted event.
 */
export class RunMcpCredentials {
  #entries = new Map<string, { headers: Record<string, string>; expiresAt: number | null }>();
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
    this.#targets = targets.map(({ id, url }) => ({ id, url }));
    this.#signal = options.signal;
    this.#now = options.now ?? Date.now;
    this.#signal?.addEventListener("abort", this.#onAbort, { once: true });
  }

  close(): void {
    this.#closed = true;
    this.#entries.clear();
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
    for (const entry of parsed.data) {
      const matches = (this.#remoteTargets ?? this.#targets).filter(
        (target) => target.id === entry.server || target.url === entry.server,
      );
      if (matches.length !== 1) {
        throw new RunMcpCredentialError("Run MCP credential target is unmatched or ambiguous");
      }
      const id = matches[0]!.id;
      if (next.has(id)) {
        throw new RunMcpCredentialError("Run MCP credential target is declared twice");
      }
      const expiry = entry.expiresAt ? Date.parse(entry.expiresAt) : null;
      const expiresAt =
        expiry === null
          ? (material?.expiresAt?.getTime() ?? null)
          : Math.min(expiry, material?.expiresAt?.getTime() ?? Infinity);
      if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= this.#now())) {
        throw new RunMcpCredentialError("Run MCP credential expiry is invalid or already expired");
      }
      next.set(id, { headers: { ...entry.headers }, expiresAt });
    }
    return () => {
      this.#assertOpen();
      // Tool construction can exclude a local route while a sandbox write is
      // pending. Recheck the narrowed transport set at the atomic commit too.
      if (
        this.#remoteTargets &&
        [...next.keys()].some((id) => !this.#remoteTargets!.some((target) => target.id === id))
      ) {
        throw new RunMcpCredentialError("Run MCP credentials require a selected remote target");
      }
      this.#entries = next;
    };
  }

  replace(material: RunMcpCredentialMaterial | null): void {
    this.prepare(material)();
  }

  /** Refuse credentials for omitted, local, or rewritten server routes. */
  assertRemoteTargets(targets: readonly RunMcpCredentialTarget[]): void {
    for (const id of this.#entries.keys()) {
      const original = this.#targets.find((target) => target.id === id);
      if (!targets.some((target) => target.id === id && target.url === original?.url)) {
        throw new RunMcpCredentialError("Run MCP credentials require a selected remote target");
      }
    }
    this.#remoteTargets = this.#targets.filter((original) =>
      targets.some((target) => target.id === original.id && target.url === original.url),
    );
  }

  excludeLocalTarget(id: string): void {
    if (this.has(id)) {
      throw new RunMcpCredentialError("Run MCP credentials require a remote MCP transport");
    }
    this.#remoteTargets = (this.#remoteTargets ?? this.#targets).filter(
      (target) => target.id !== id,
    );
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  /** Called at the literal fetch boundary, including POST, SSE GET and DELETE. */
  requestInit(
    target: RunMcpCredentialTarget,
    input: string | URL | Request,
    init?: RequestInit,
  ): RequestInit | undefined {
    this.#assertOpen();
    const entry = this.#entries.get(target.id);
    if (!entry) return init;
    const destination = input instanceof Request ? input.url : String(input);
    if (new URL(destination).href !== new URL(target.url).href) {
      throw new RunMcpCredentialError("Run MCP credential request destination changed");
    }
    if (entry.expiresAt !== null && entry.expiresAt <= this.#now()) {
      // The transport's immutable static headers remain the fallback; the old
      // provider material is never injected into requestInit in the first place.
      return init;
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
