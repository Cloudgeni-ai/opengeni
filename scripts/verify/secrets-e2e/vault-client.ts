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
