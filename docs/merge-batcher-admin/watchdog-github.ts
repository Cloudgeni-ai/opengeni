import { createHash, createSign } from "node:crypto";
import { WatchdogCloud } from "./watchdog-cloud";
export type AppBinding = {
  appId: number;
  installationId: number;
  repositoryId: number;
  keyVersion: string;
};
const restorePermissions = {
  administration: "write",
  contents: "read",
  actions: "read",
  issues: "write",
} as const;
export class WatchdogGitHub {
  private cached: { token: string; until: number } | null = null;
  constructor(
    private readonly cloud: WatchdogCloud,
    private readonly app: AppBinding,
    private readonly transport: typeof fetch = fetch,
    private readonly capability: "restore" | "state-fence" = "restore",
  ) {}
  async token(): Promise<string> {
    if (this.cached && this.cached.until > Date.now() + 60_000) return this.cached.token;
    if (
      ![this.app.appId, this.app.installationId, this.app.repositoryId].every(
        (id) => Number.isSafeInteger(id) && id > 0,
      )
    )
      throw Error("Assigned watchdog App identity required");
    // The runtime writer must never acquire administration permission.
    if (this.capability === "restore" && this.app.appId === 5425399)
      throw Error("Watchdog requires a separate App, not the runtime App");
    const permissions =
      this.capability === "state-fence" ? { contents: "write" } : restorePermissions;
    const privateKey = await this.cloud.secret(this.app.keyVersion);
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const message = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: this.app.appId, iat: now - 60, exp: now + 540 })}`;
    const jwt = `${message}.${createSign("RSA-SHA256").update(message).sign(privateKey, "base64url")}`;
    const response = await this.transport(
      `https://api.github.com/app/installations/${this.app.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ repository_ids: [this.app.repositoryId], permissions }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw Error(`Watchdog token mint failed (${response.status}); body suppressed`);
    const value = (await response.json()) as {
      token?: string;
      expires_at?: string;
      permissions?: { [key: string]: string };
    };
    if (
      !value.token ||
      !Number.isFinite(Date.parse(value.expires_at ?? "")) ||
      Date.parse(value.expires_at!) <= Date.now() + 60_000 ||
      Object.entries(permissions).some(([key, access]) => value.permissions?.[key] !== access) ||
      Object.keys(value.permissions ?? {}).some(
        (key) => !(key in permissions) && key !== "metadata",
      )
    )
      throw Error("Watchdog token permissions mismatch");
    try {
      const repos = await this.transport(
        "https://api.github.com/installation/repositories?per_page=100",
        {
          headers: {
            Authorization: `Bearer ${value.token}`,
            Accept: "application/vnd.github+json",
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!repos.ok) throw Error("Watchdog repository verification failed; body suppressed");
      const inventory = (await repos.json()) as {
        total_count?: number;
        repositories?: { id: number; full_name: string }[];
      };
      if (
        inventory.total_count !== 1 ||
        inventory.repositories?.length !== 1 ||
        inventory.repositories[0]!.id !== this.app.repositoryId ||
        inventory.repositories[0]!.full_name !== "Cloudgeni-ai/opengeni"
      ) {
        throw Error("Watchdog token repository mismatch");
      }
      this.cached = { token: value.token, until: Date.parse(value.expires_at!) };
      return value.token;
    } catch (error) {
      this.cached = null;
      throw error;
    }
  }
  async request(path: string, method = "GET", body?: unknown): Promise<Response> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw Error("GitHub relative API path required");
    const response = await this.transport(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok)
      throw Error(`Watchdog GitHub ${method} failed (${response.status}); body suppressed`);
    return response;
  }
  async notify(
    thread: number,
    id: string,
    reason: string,
    receipt: string | null,
    mode: "first" | "reconcile",
  ): Promise<boolean> {
    if (this.capability !== "restore") throw Error("State-fence token cannot post comments");
    if (!Number.isSafeInteger(thread) || thread <= 0)
      throw Error("Configured incident issue/PR required; no destination is invented");
    const marker = `<!-- batcher-watchdog:${createHash("sha256").update(id).digest("hex")} -->`;
    let matches = 0;
    for (let page = 1; ; page++) {
      const response = await this.request(
        `/repos/Cloudgeni-ai/opengeni/issues/${thread}/comments?per_page=100&page=${page}`,
      );
      const comments = (await response.json()) as {
        body?: string;
        performed_via_github_app?: { id?: number };
      }[];
      if (!Array.isArray(comments)) throw Error("Incomplete incident comment inventory");
      matches += comments.filter(
        (comment) =>
          comment.performed_via_github_app?.id === this.app.appId &&
          typeof comment.body === "string" &&
          comment.body.includes(marker),
      ).length;
      if (!response.headers.get("link")?.includes('rel="next"')) break;
      if (page >= 100) throw Error("Incident pagination bound reached; absence unknown");
    }
    if (matches > 1) throw Error("Ambiguous incident markers; no post");
    if (matches === 1) return true;
    if (mode === "reconcile") return false;
    const body = `${marker}\nBatcher watchdog: ${reason}\n${receipt ? `Verified restoration receipt digest: ${receipt}` : "No verified Manual restoration is claimed."}\nON remains deliberate.`;
    await this.request(`/repos/Cloudgeni-ai/opengeni/issues/${thread}/comments`, "POST", { body });
    return true;
  }
}
