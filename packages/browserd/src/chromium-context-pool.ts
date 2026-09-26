import { randomUUID } from "node:crypto";
import {
  AgentBrowserDriver,
  type AgentBrowserDriverOptions,
  type BrowserCdpConnection,
  type BrowserCommandRunner,
} from "./cdp-driver";
import { CdpConnection, CdpTransportError } from "./cdp";

export type EphemeralChromiumPoolOptions = {
  /** Trusted owner/egress/configuration partition. Never derive from an agent argument. */
  authorityKey: string;
  maxContexts?: number;
  /** Must launch a new, private, headless Chromium process; never an attached browser. */
  launch: () => Promise<BrowserCommandRunner>;
  connect?: (endpoint: string) => Promise<BrowserCdpConnection>;
};

type LeaseOptions = Pick<
  AgentBrowserDriverOptions,
  | "browserSessionId"
  | "controllerGeneration"
  | "resolveWorkspaceFiles"
  | "downloadDirectory"
  | "downloadEvents"
  | "emulation"
>;

/** Experimental construction-only path for bounded disposable verification.
 * No supervisor/API selects this pool. Contexts share a browser crash boundary;
 * they are not a security sandbox or a substitute for durable actor profiles.
 * A failed/empty pool is terminal: a new pool requires a fresh generation and
 * fresh contexts. No dispatched command or previous identity is replayed. */
export class EphemeralChromiumContextPool {
  readonly generation = randomUUID();
  private readonly capacity: number;
  private readonly connect: (endpoint: string) => Promise<BrowserCdpConnection>;
  private runner: BrowserCommandRunner | null = null;
  private control: BrowserCdpConnection | null = null;
  private endpoint: string | null = null;
  private terminal = false;
  private shutdownPromise: Promise<void> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly leases = new Map<string, Set<BrowserCdpConnection>>();

  constructor(private readonly options: EphemeralChromiumPoolOptions) {
    this.capacity = options.maxContexts ?? 6;
    if (
      !options.authorityKey ||
      !Number.isSafeInteger(this.capacity) ||
      this.capacity < 1 ||
      this.capacity > 6
    ) {
      throw new Error("ephemeral pool requires an authority partition and 1–6 contexts");
    }
    this.connect = options.connect ?? ((endpoint) => CdpConnection.connect(endpoint));
  }

  async createDriver(authorityKey: string, options: LeaseOptions): Promise<AgentBrowserDriver> {
    return await this.serial(async () => {
      this.assertLive();
      if (authorityKey !== this.options.authorityKey)
        throw new Error("ephemeral pool authority mismatch");
      if (this.leases.size >= this.capacity)
        throw new Error("ephemeral pool context capacity reached");
      try {
        await this.ensureStarted();
        const result = await this.control!.send<{ browserContextId: string }>(
          "Target.createBrowserContext",
          { disposeOnDetach: true },
        );
        if (!result.browserContextId)
          throw new Error("Chromium did not return an ephemeral context");
        this.assertLive();
        const contextId = result.browserContextId;
        this.leases.set(contextId, new Set());
        const assertLease = () => {
          this.assertLive();
          if (!this.leases.has(contextId))
            throw new CdpTransportError("ephemeral context lease ended");
        };
        const runner: BrowserCommandRunner = {
          run: async <T>(args: readonly string[]): Promise<T> => {
            assertLease();
            if (args.length !== 2 || args[0] !== "get" || args[1] !== "cdp-url")
              throw new Error("ephemeral context runner only exposes its CDP endpoint");
            return { cdpUrl: this.endpoint } as T;
          },
          terminate: async () => {
            await this.serial(() => this.release(contextId));
          },
        };
        return new AgentBrowserDriver({
          ...options,
          runner,
          engine: "chromium",
          targetLifecycle: "cdp",
          browserContextId: contextId,
          foregroundManagedTabs: false,
          connect: async (endpoint) => {
            assertLease();
            let connection: BrowserCdpConnection;
            try {
              connection = await this.connect(endpoint);
            } catch (error) {
              await this.shutdown();
              throw error;
            }
            try {
              assertLease();
            } catch (error) {
              connection.close();
              throw error;
            }
            this.leases.get(contextId)!.add(connection);
            return {
              send: async <T>(
                method: string,
                params?: Readonly<Record<string, unknown>>,
                callOptions?: Parameters<BrowserCdpConnection["send"]>[2],
              ): Promise<T> => {
                assertLease();
                try {
                  return await connection.send<T>(method, params, callOptions);
                } catch (error) {
                  if (error instanceof CdpTransportError && this.leases.has(contextId))
                    await this.shutdown();
                  throw error;
                }
              },
              on: (method, listener, sessionId) =>
                connection.on(
                  method,
                  (event) => {
                    if (!this.terminal && this.leases.has(contextId)) listener(event);
                  },
                  sessionId,
                ),
              waitForEvent: (method, callOptions) => {
                assertLease();
                return connection.waitForEvent(method, callOptions);
              },
              close: () => {
                this.leases.get(contextId)?.delete(connection);
                connection.close();
              },
            };
          },
        });
      } catch (error) {
        // A create timeout can have created a context. End this owned process,
        // rather than retrying creation and leaking an untracked identity.
        await this.shutdown();
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.serial(() => this.shutdown());
  }

  private assertLive(): void {
    if (this.terminal) throw new CdpTransportError("ephemeral browser pool generation ended");
  }

  private async ensureStarted(): Promise<void> {
    if (this.control) return;
    this.runner = await this.options.launch();
    if (!this.runner.terminate)
      throw new Error("ephemeral pool launcher must own process termination");
    this.assertLive();
    const result = await this.runner.run<{ cdpUrl?: string }>(["get", "cdp-url"]);
    if (!result.cdpUrl) throw new Error("ephemeral browser did not expose CDP");
    this.endpoint = result.cdpUrl;
    this.control = await this.connect(this.endpoint);
  }

  private async release(contextId: string): Promise<void> {
    const connections = this.leases.get(contextId);
    if (!connections) {
      await this.shutdownPromise;
      return;
    }
    this.leases.delete(contextId);
    for (const connection of connections) connection.close();
    try {
      await this.control!.send("Target.disposeBrowserContext", { browserContextId: contextId });
    } catch (error) {
      await this.shutdown();
      throw error;
    }
    if (this.leases.size === 0) await this.shutdown();
  }

  private shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.terminal = true;
    this.shutdownPromise = Promise.resolve().then(async () => {
      for (const connections of this.leases.values())
        for (const connection of connections) connection.close();
      this.leases.clear();
      this.control?.close();
      await this.runner?.terminate?.();
    });
    return this.shutdownPromise;
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return await result;
  }
}
