/**
 * REST client for the planned vault API (dossier §10B.1.10; every route lives
 * under `/v1/workspaces/:workspaceId`). Until F1/F2/W2 land these routes return
 * 404 and the gate reports the scenario as `missing_feature`; once they land,
 * the scenarios run unchanged. Request shapes follow `packages/contracts/src/vaults.ts`
 * as specified in dossier §10B.1.1 and will be switched to the real contract
 * types when that module exists.
 */
import type { ApiResult, StackApi } from "./stack";

export type VaultOwnerKind = "user" | "workspace" | "organization";

export type CreateVaultRequest = { name: string; owner: VaultOwnerKind; description?: string };

export type VaultFieldInput = {
  name: string;
  kind: "text" | "concealed" | "totp" | "file";
  value?: string;
  /** Ask the server generator for a value (dossier §10B.1.6). */
  generate?: { length?: number; symbols?: boolean };
};

export type CreateVaultItemRequest = {
  type: "login" | "api_key" | "note" | "file";
  name: string;
  websites?: string[];
  fields: VaultFieldInput[];
};

export class VaultClient {
  constructor(
    readonly api: StackApi,
    readonly workspaceId: string,
  ) {}

  #path(suffix: string): string {
    return `/v1/workspaces/${this.workspaceId}${suffix}`;
  }

  listVaults(): Promise<ApiResult> {
    return this.api.request("GET", this.#path("/vaults"));
  }

  createVault(body: CreateVaultRequest): Promise<ApiResult> {
    return this.api.request("POST", this.#path("/vaults"), body);
  }

  listItems(vaultId: string): Promise<ApiResult> {
    return this.api.request("GET", this.#path(`/vaults/${vaultId}/items`));
  }

  createItem(vaultId: string, body: CreateVaultItemRequest): Promise<ApiResult> {
    return this.api.request("POST", this.#path(`/vaults/${vaultId}/items`), body);
  }

  /** Create after permanently removing same-named items left by an earlier gate run. */
  async replaceItem(vaultId: string, body: CreateVaultItemRequest): Promise<ApiResult> {
    const existing: any[] = (await this.listItems(vaultId)).json?.items ?? [];
    for (const row of existing.filter((candidate) => candidate.name === body.name)) {
      await this.archiveItem(vaultId, row.id);
      await this.archiveItem(vaultId, row.id, true);
    }
    return this.createItem(vaultId, body);
  }

  /** DELETE archives (Q-12); `permanent` deletes an already archived item. */
  archiveItem(vaultId: string, itemId: string, permanent = false): Promise<ApiResult> {
    const query = permanent ? "?permanent=true" : "";
    return this.api.request("DELETE", this.#path(`/vaults/${vaultId}/items/${itemId}${query}`));
  }

  revealField(vaultId: string, itemId: string, fieldId: string): Promise<ApiResult> {
    return this.api.request(
      "POST",
      this.#path(`/vaults/${vaultId}/items/${itemId}/fields/${fieldId}/reveal`),
      {},
    );
  }

  /**
   * The first live item with this exact name in any vault the caller can see;
   * `contains` also accepts names that include it (the agent names items).
   */
  async findItemByName(
    name: string,
    options: { contains?: boolean } = {},
  ): Promise<{ id: string; vaultId: string } | null> {
    const vaults: any[] = (await this.listVaults()).json?.vaults ?? [];
    for (const vault of vaults) {
      const page = await this.api.request(
        "GET",
        this.#path(`/vaults/${vault.id}/items?q=${encodeURIComponent(name)}`),
      );
      const item = (page.json?.items ?? []).find((row: any) =>
        options.contains ? String(row.name).includes(name) : row.name === name,
      );
      if (item) return { id: item.id, vaultId: vault.id };
    }
    return null;
  }

  /** Reveal a field by name; null when the item has no such field or reveal fails. */
  async revealFieldByName(vaultId: string, itemId: string, field: string): Promise<string | null> {
    const item = await this.api.request("GET", this.#path(`/vaults/${vaultId}/items/${itemId}`));
    const row = (item.json?.fields ?? []).find((candidate: any) => candidate.name === field);
    if (!row) return null;
    const revealed = await this.revealField(vaultId, itemId, row.id);
    return revealed.ok ? String(revealed.json?.value ?? "") : null;
  }

  sessionSecrets(sessionId: string): Promise<ApiResult> {
    return this.api.request("GET", this.#path(`/sessions/${sessionId}/secrets`));
  }

  setSessionVaultPolicy(sessionId: string, policy: Record<string, unknown>): Promise<ApiResult> {
    return this.api.request("PUT", this.#path(`/sessions/${sessionId}/vault-policy`), { policy });
  }

  installOnePassword(body: Record<string, unknown>): Promise<ApiResult> {
    return this.api.request("POST", this.#path("/connections/1password/install"), body);
  }

  linkVaults(body: Record<string, unknown>): Promise<ApiResult> {
    return this.api.request("POST", this.#path("/vaults/link"), body);
  }

  /** Legacy variable-set routes; after W4 they must answer 410 Gone (RM-1, DP-1). */
  legacyVariableSets(): Promise<ApiResult> {
    return this.api.request("GET", this.#path("/variable-sets"));
  }
}
