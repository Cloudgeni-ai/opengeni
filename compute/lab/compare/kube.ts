/**
 * A minimal Kubernetes API client: bearer-token requests and a list-then-
 * watch cache per resource, which is what a production orchestrator would
 * keep instead of one watch per object.
 */
import { readFileSync } from "node:fs";

export interface KubeObject {
  metadata: { name: string; namespace?: string; resourceVersion?: string; uid?: string; annotations?: Record<string, string>; labels?: Record<string, string> };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown> & { conditions?: Condition[] };
}

export interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export class KubeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class Kube {
  private readonly ca: string;

  constructor(
    readonly server: string,
    private readonly token: string,
    caFile: string,
  ) {
    this.ca = readFileSync(caFile, "utf8");
  }

  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.server}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...(init.headers ?? {}) },
      tls: { ca: this.ca },
    } as RequestInit);
  }

  async request<T = KubeObject>(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<T> {
    const response = await this.fetch(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { "Content-Type": contentType },
    });
    const text = await response.text();
    if (!response.ok) throw new KubeError(`${method} ${path}: ${response.status} ${text.slice(0, 300)}`, response.status);
    return JSON.parse(text) as T;
  }

  mergePatch(path: string, body: unknown) {
    return this.request("PATCH", path, body, "application/merge-patch+json");
  }
}

export function condition(object: KubeObject | undefined, type: string): Condition | undefined {
  return object?.status?.conditions?.find((entry) => entry.type === type);
}

interface Waiter {
  check: (object: KubeObject | undefined) => boolean;
  resolve: (object: KubeObject | undefined) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Keeps every object of one resource in one namespace current through a
 * watch, and lets callers wait until an object satisfies a check.
 */
export class Informer {
  private readonly objects = new Map<string, KubeObject>();
  private readonly waiters = new Map<string, Set<Waiter>>();
  private stopped = false;
  private abort?: AbortController;
  private ready?: Promise<void>;

  constructor(
    private readonly kube: Kube,
    /** Collection path, such as `/apis/G/V/namespaces/N/sandboxes`. */
    private readonly path: string,
  ) {}

  start(): Promise<void> {
    this.ready ??= new Promise((resolve, reject) => {
      void this.run(resolve, reject);
    });
    return this.ready;
  }

  stop() {
    this.stopped = true;
    this.abort?.abort();
  }

  get(name: string): KubeObject | undefined {
    return this.objects.get(name);
  }

  names(): string[] {
    return [...this.objects.keys()];
  }

  /** Resolves with the object once `check` holds for it (or its absence). */
  wait(name: string, check: (object: KubeObject | undefined) => boolean, timeoutMs: number, what: string): Promise<KubeObject | undefined> {
    return new Promise((resolve, reject) => {
      try {
        if (check(this.objects.get(name))) {
          resolve(this.objects.get(name));
          return;
        }
      } catch (error) {
        reject(error as Error);
        return;
      }
      const waiter: Waiter = {
        check,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.get(name)?.delete(waiter);
          reject(new Error(`timed out after ${timeoutMs} ms waiting for ${what}`));
        }, timeoutMs),
      };
      let set = this.waiters.get(name);
      if (!set) {
        set = new Set();
        this.waiters.set(name, set);
      }
      set.add(waiter);
    });
  }

  private update(name: string, object: KubeObject | undefined) {
    if (object) this.objects.set(name, object);
    else this.objects.delete(name);
    const set = this.waiters.get(name);
    if (!set) return;
    for (const waiter of [...set]) {
      let done = false;
      try {
        done = waiter.check(object);
      } catch (error) {
        set.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(error as Error);
        continue;
      }
      if (done) {
        set.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(object);
      }
    }
    if (set.size === 0) this.waiters.delete(name);
  }

  private async list(): Promise<string> {
    const list = await this.kube.request<{ metadata: { resourceVersion: string }; items: KubeObject[] }>("GET", this.path);
    const seen = new Set<string>();
    for (const item of list.items) {
      seen.add(item.metadata.name);
      this.update(item.metadata.name, item);
    }
    for (const name of [...this.objects.keys()]) if (!seen.has(name)) this.update(name, undefined);
    return list.metadata.resourceVersion;
  }

  private async run(resolve: () => void, reject: (error: Error) => void) {
    let version: string;
    try {
      version = await this.list();
    } catch (error) {
      reject(error as Error);
      return;
    }
    resolve();
    while (!this.stopped) {
      try {
        version = await this.watch(version);
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof KubeError && error.status === 410) {
          version = await this.list().catch(() => version);
        } else {
          await Bun.sleep(200);
        }
      }
    }
  }

  /** One watch request; returns the last resource version seen. */
  private async watch(from: string): Promise<string> {
    this.abort = new AbortController();
    const response = await this.kube.fetch(`${this.path}?watch=1&allowWatchBookmarks=true&resourceVersion=${from}&timeoutSeconds=300`, { signal: this.abort.signal });
    if (!response.ok || !response.body) throw new KubeError(`watch ${this.path}: ${response.status}`, response.status);
    let version = from;
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk as Uint8Array, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
        if (!line.trim()) continue;
        const event = JSON.parse(line) as { type: string; object: KubeObject & { code?: number } };
        if (event.type === "ERROR") throw new KubeError(`watch error: ${JSON.stringify(event.object)}`, event.object.code ?? 500);
        version = event.object.metadata?.resourceVersion ?? version;
        if (event.type === "BOOKMARK") continue;
        this.update(event.object.metadata.name, event.type === "DELETED" ? undefined : event.object);
      }
    }
    return version;
  }
}
