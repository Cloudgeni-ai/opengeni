/** Workload-identity-only Google APIs. Importing performs no I/O. */
export class CloudFailure extends Error {
  constructor(
    readonly status: number,
    operation: string,
  ) {
    super(`${operation} failed (${status}); provider body suppressed`);
  }
}
export class WatchdogCloud {
  private cached: { token: string; until: number } | null = null;
  constructor(
    private readonly transport: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {}
  async token(): Promise<string> {
    if (this.cached && this.cached.until > this.now() + 60_000) return this.cached.token;
    const response = await this.transport(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      {
        headers: { "Metadata-Flavor": "Google" },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new CloudFailure(response.status, "workload token");
    const value = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!value.access_token || !Number.isFinite(value.expires_in) || value.expires_in! <= 0)
      throw Error("Invalid workload token response");
    this.cached = { token: value.access_token, until: this.now() + value.expires_in! * 1000 };
    return value.access_token;
  }
  async identityToken(audience: string): Promise<string> {
    const url = new URL(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity",
    );
    url.searchParams.set("audience", audience);
    url.searchParams.set("format", "full");
    const response = await this.transport(url, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new CloudFailure(response.status, "workload identity token");
    return response.text();
  }
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.transport(url, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        Authorization: `Bearer ${await this.token()}`,
      },
      signal: init.signal ?? AbortSignal.timeout(120_000),
    });
    return response;
  }
  async json<T>(url: string, method = "GET", body?: unknown): Promise<T> {
    const response = await this.request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new CloudFailure(response.status, `Google ${method}`);
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
  }
  async secret(version: string): Promise<string> {
    if (!/^projects\/[^/]+\/secrets\/[^/]+\/versions\/\d+$/.test(version))
      throw Error("Pinned secret version required");
    const value = await this.json<{ payload?: { data?: string } }>(
      `https://secretmanager.googleapis.com/v1/${version}:access`,
    );
    if (!value.payload?.data) throw Error("Secret payload missing");
    return Buffer.from(value.payload.data, "base64").toString("utf8");
  }
}

export type ObjectValue<T> = { generation: string; value: T };
/** CAS is required even for first creation. A lost response is never retried. */
export class ObjectStore {
  constructor(
    private readonly cloud: WatchdogCloud,
    readonly bucket: string,
  ) {
    if (!/^[a-z0-9][a-z0-9._-]+$/.test(bucket)) throw Error("Invalid dedicated state bucket");
  }
  async read<T>(name: string, generation?: string): Promise<ObjectValue<T> | null> {
    const base = `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o/${encodeURIComponent(name)}`;
    const metadata = await this.cloud.request(
      `${base}${generation ? `?generation=${encodeURIComponent(generation)}` : ""}`,
    );
    if (metadata.status === 404) return null;
    if (!metadata.ok) throw new CloudFailure(metadata.status, "object metadata");
    const head = (await metadata.json()) as { generation?: string };
    if (
      !head.generation ||
      !/^\d+$/.test(head.generation) ||
      (generation && generation !== head.generation)
    )
      throw Error("Object generation mismatch");
    const value = await this.cloud.json<T>(`${base}?alt=media&generation=${head.generation}`);
    return { generation: head.generation, value };
  }
  async cas<T>(name: string, generation: string | null, value: T): Promise<string | null> {
    if (generation !== null && !/^\d+$/.test(generation))
      throw Error("Invalid expected generation");
    const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${this.bucket}/o`);
    url.searchParams.set("uploadType", "media");
    url.searchParams.set("name", name);
    url.searchParams.set("ifGenerationMatch", generation ?? "0");
    const response = await this.cloud.request(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    if (response.status === 412) return null;
    if (!response.ok)
      throw new CloudFailure(response.status, "object CAS (outcome may be unknown)");
    const result = (await response.json()) as { generation?: string };
    if (!result.generation || !/^\d+$/.test(result.generation))
      throw Error("Object CAS receipt unknown");
    return result.generation;
  }
}
