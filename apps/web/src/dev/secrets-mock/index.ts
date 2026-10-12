// DEV-only fetch interceptor for the vault REST routes (dossier §10B.1.10).
// On when localStorage "og-dev-secrets-mock" is "1"; never in production
// bundles (main.tsx imports it behind import.meta.env.DEV).
//
//   og-dev-secrets-mock-role      owner | admin | member | viewer (default owner)
//   og-dev-secrets-mock-scenario  comma list: empty, error, missing-key, slow,
//                                 capability-off, rate-limited, auth-expired,
//                                 many-vaults, conflict, empty-task, narrowed,
//                                 inherited
import {
  totpCodeSync,
  totpRemainingMs,
  parseTotpInput,
  generatePassword,
} from "@opengeni/contracts";
import type { VaultItemSummary, VaultSummary } from "@opengeni/react";

import { buildMockState, mockId, MOCK_NOW, type MockItem, type MockState } from "./fixtures";

const FLAG = "og-dev-secrets-mock";

export function secretsMockEnabled(): boolean {
  try {
    return window.localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

function setting(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function scenarios(): Set<string> {
  return new Set(
    setting(`${FLAG}-scenario`)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

type Role = "owner" | "admin" | "member" | "viewer";
function role(): Role {
  const value = setting(`${FLAG}-role`);
  return value === "admin" || value === "member" || value === "viewer" ? value : "owner";
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fail(status: number, code: string, message: string, details?: Record<string, unknown>) {
  return json(status, { error: { code, message, ...(details ? { details } : {}) } });
}

const states = new Map<string, MockState>();
function stateFor(workspaceId: string): MockState {
  let state = states.get(workspaceId);
  if (!state) {
    state = buildMockState(workspaceId);
    if (scenarios().has("many-vaults")) {
      for (let index = 0; index < 32; index += 1) {
        const base = state.vaults[1]!;
        state.vaults.push({
          ...base,
          id: mockId(`many-${index}`),
          name: `Team vault ${String(index + 1).padStart(2, "0")}`,
          isDefault: false,
          description: null,
          itemCount: (index * 7) % 23,
        });
      }
    }
    states.set(workspaceId, state);
  }
  return state;
}

function visibleVault(vault: VaultSummary): VaultSummary {
  const who = role();
  const ownedByMe = vault.ownerKind === "user" || vault.ownerKind === "task";
  const writable = vault.mode === "read_write";
  const canWrite =
    writable &&
    (who === "owner" ||
      who === "admin" ||
      (who === "member" && vault.ownerKind !== "organization"));
  const canManage =
    who === "owner" || who === "admin" ? true : who === "member" ? ownedByMe : false;
  let syncStatus = vault.syncStatus;
  let rateLimitedUntil = vault.rateLimitedUntil;
  const active = scenarios();
  if (vault.source === "onepassword" && vault.mode === "read_only") {
    if (active.has("rate-limited")) {
      syncStatus = "rate_limited";
      rateLimitedUntil = new Date(MOCK_NOW + 25 * 60_000).toISOString();
    } else if (active.has("auth-expired")) {
      syncStatus = "auth_expired";
    }
  }
  return {
    ...vault,
    canWrite,
    canManage,
    syncStatus,
    rateLimitedUntil,
  };
}

function summary(item: MockItem): VaultItemSummary {
  const {
    fields: _fields,
    passkey: _passkey,
    aliases: _aliases,
    primaryFieldId: _p,
    createdBySubjectId: _c,
    createdAt: _ca,
    generation: _g,
    ...rest
  } = item;
  return rest;
}

function detail(item: MockItem) {
  return {
    ...item,
    fields: item.fields.map(({ versions: _versions, ...field }) => field),
  };
}

function refresh(state: MockState, vaultId: string) {
  const vault = state.vaults.find((each) => each.id === vaultId);
  if (vault) {
    vault.itemCount = state.items.filter(
      (each) => each.vaultId === vaultId && !each.archivedAt,
    ).length;
    vault.updatedAt = new Date().toISOString();
  }
}

type Handler = (match: RegExpMatchArray, body: any, url: URL) => Response | Promise<Response>;
type Route = { method: string; pattern: RegExp; handle: Handler };

function routes(state: MockState): Route[] {
  const vaultOf = (id: string) => state.vaults.find((each) => each.id === id);
  const itemOf = (vaultId: string, id: string) =>
    state.items.find((each) => each.vaultId === vaultId && each.id === id);
  const notFound = () => fail(404, "vault_not_found", "Vault not found.");
  const readOnly = (vault: VaultSummary) =>
    !visibleVault(vault).canWrite
      ? vault.mode === "read_only"
        ? fail(409, "vault_read_only", "Vault is read-only.")
        : fail(403, "vault_permission_denied", "Permission denied.")
      : null;

  const fieldsFromInput = (owner: VaultSummary, itemName: string, inputs: any[] = []) =>
    inputs
      .filter((input) => !input.remove)
      .map((input, position) => {
        const kind = input.kind ?? (input.name === "username" ? "text" : "concealed");
        const value = input.generate ? generatePassword(input.generate) : (input.value ?? "");
        return {
          id: mockId(`${itemName}/${input.name}`),
          name: input.name,
          kind,
          position,
          currentVersion: 1,
          value: kind === "text" ? value : null,
          fileName: input.fileName ?? null,
          fileSize: input.fileBase64 ? Math.round((input.fileBase64.length * 3) / 4) : null,
          reference: `{{secret:${owner.name}/${itemName}/${input.name}}}`,
          updatedAt: new Date().toISOString(),
          versions: [{ value, createdAt: new Date().toISOString(), by: "human" as const }],
        };
      });

  const first: Route[] = [
    {
      method: "GET",
      pattern: /\/vaults$/,
      handle: () => {
        const active = scenarios();
        if (active.has("missing-key"))
          return fail(503, "encryption_key_missing", "Secrets encryption key is not configured.");
        if (active.has("error")) return fail(500, "internal_error", "Something went wrong.");
        if (active.has("empty")) return json(200, { vaults: [] });
        return json(200, {
          vaults: state.vaults.filter((each) => each.ownerKind !== "task").map(visibleVault),
        });
      },
    },
    {
      method: "POST",
      pattern: /\/vaults$/,
      handle: (_m, body) => {
        if (
          state.vaults.some((each) => each.name.toLowerCase() === String(body.name).toLowerCase())
        )
          return fail(409, "vault_name_conflict", "Name taken.");
        const base = state.vaults[1]!;
        const created: VaultSummary = {
          ...base,
          id: mockId(`new-${body.name}`),
          name: body.name,
          description: body.description ?? null,
          ownerKind: body.ownerKind,
          ownerLabel: body.ownerKind === "user" ? "Only me" : "Platform engineering",
          availability:
            body.ownerKind === "organization"
              ? (body.availability ?? { allowedWorkspaceIds: null, allowPersonalWorkspaces: true })
              : null,
          isDefault: false,
          itemCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        state.vaults.push(created);
        return json(201, visibleVault(created));
      },
    },
    {
      method: "POST",
      pattern: /\/vaults\/link$/,
      handle: (_m, body) => {
        const base = state.vaults.find((each) => each.source === "onepassword")!;
        const created: VaultSummary = {
          ...base,
          id: mockId(`link-${body.externalVaultId}`),
          name: body.name ?? `1P ${body.externalVaultId}`,
          ownerKind: body.ownerKind,
          mode: body.mode,
          providerConnectionId: body.connectionId ?? null,
          syncStatus: "ok",
          syncErrorCode: null,
          syncErrorMessage: null,
          itemCount: 4,
        };
        state.vaults.push(created);
        return json(201, visibleVault(created));
      },
    },
    {
      method: "GET",
      pattern: /\/vaults\/([^/]+)$/,
      handle: (match) => {
        const vault = vaultOf(match[1]!);
        return vault ? json(200, visibleVault(vault)) : notFound();
      },
    },
    {
      method: "PATCH",
      pattern: /\/vaults\/([^/]+)$/,
      handle: (match, body) => {
        const vault = vaultOf(match[1]!);
        if (!vault) return notFound();
        if (body.expectedGeneration !== vault.generation)
          return fail(409, "vault_generation_conflict", "Changed elsewhere.");
        Object.assign(vault, {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.availability !== undefined ? { availability: body.availability } : {}),
          generation: vault.generation + 1,
          updatedAt: new Date().toISOString(),
        });
        return json(200, visibleVault(vault));
      },
    },
    {
      method: "DELETE",
      pattern: /\/vaults\/([^/]+)$/,
      handle: (match) => {
        state.vaults = state.vaults.filter((each) => each.id !== match[1]);
        return new Response(null, { status: 204 });
      },
    },
    {
      method: "POST",
      pattern: /\/vaults\/([^/]+)\/sync$/,
      handle: (match) => {
        const vault = vaultOf(match[1]!);
        if (!vault) return notFound();
        Object.assign(vault, {
          syncStatus: "ok",
          syncErrorCode: null,
          syncErrorMessage: null,
          lastSyncedAt: new Date().toISOString(),
        });
        return json(200, visibleVault(vault));
      },
    },
    {
      method: "GET",
      pattern: /\/vaults\/([^/]+)\/items$/,
      handle: (match, _body, url) => {
        const vault = vaultOf(match[1]!);
        if (!vault) return notFound();
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const type = url.searchParams.get("type");
        const archived = url.searchParams.get("includeArchived") === "true";
        const items = state.items
          .filter((each) => each.vaultId === vault.id)
          .filter((each) => archived || !each.archivedAt)
          .filter((each) => !type || each.type === type)
          .filter(
            (each) =>
              !q ||
              each.name.toLowerCase().includes(q) ||
              (each.username ?? "").toLowerCase().includes(q) ||
              each.websites.some((site) => site.toLowerCase().includes(q)),
          )
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(summary);
        return json(200, { items, nextCursor: null });
      },
    },
    {
      method: "POST",
      pattern: /\/vaults\/([^/]+)\/items$/,
      handle: (match, body) => {
        const vault = vaultOf(match[1]!);
        if (!vault) return notFound();
        const blocked = readOnly(vault);
        if (blocked) return blocked;
        if (
          state.items.some(
            (each) =>
              each.vaultId === vault.id &&
              each.name.toLowerCase() === String(body.name).toLowerCase(),
          )
        )
          return fail(409, "vault_item_name_conflict", "Name taken.");
        const fields = fieldsFromInput(vault, body.name, body.fields);
        const primary = fields.find(
          (field) =>
            field.name ===
            (body.primaryFieldName ??
              (body.type === "login"
                ? "password"
                : body.type === "api_key"
                  ? "value"
                  : body.type === "note"
                    ? "note"
                    : "file")),
        );
        const totp = fields.find((field) => field.kind === "totp");
        const now = new Date().toISOString();
        const created: MockItem = {
          id: mockId(`item-${body.name}`),
          vaultId: vault.id,
          type: body.type,
          name: body.name,
          websites: body.websites ?? [],
          username: fields.find((field) => field.name === "username")?.value ?? null,
          hasTotp: Boolean(totp),
          hasPasskey: false,
          expiresAt: body.expiresAt ?? null,
          archivedAt: null,
          lastUsedAt: null,
          updatedAt: now,
          references: {
            primary: primary ? `{{secret:${vault.name}/${body.name}/${primary.name}}}` : null,
            otp: totp ? `{{secret:${vault.name}/${body.name}/${totp.name}/otp}}` : null,
            byField: Object.fromEntries(fields.map((field) => [field.name, field.reference])),
          },
          fields,
          passkey: null,
          aliases: [],
          primaryFieldId: primary?.id ?? null,
          createdBySubjectId: null,
          createdAt: now,
          generation: 1,
        };
        state.items.push(created);
        refresh(state, vault.id);
        return json(201, detail(created));
      },
    },
    {
      method: "GET",
      pattern: /\/vaults\/([^/]+)\/items\/([^/]+)$/,
      handle: (match) => {
        const found = itemOf(match[1]!, match[2]!);
        return found
          ? json(200, detail(found))
          : fail(404, "vault_item_not_found", "Item not found.");
      },
    },
    {
      method: "PATCH",
      pattern: /\/vaults\/([^/]+)\/items\/([^/]+)$/,
      handle: (match, body) => {
        const vault = vaultOf(match[1]!);
        const found = itemOf(match[1]!, match[2]!);
        if (!vault || !found) return fail(404, "vault_item_not_found", "Item not found.");
        const blocked = readOnly(vault);
        if (blocked) return blocked;
        if (scenarios().has("conflict") || body.expectedGeneration !== found.generation)
          return fail(409, "vault_generation_conflict", "Changed elsewhere.");
        if (body.name && body.name !== found.name) {
          found.aliases = [found.name, ...found.aliases];
          found.name = body.name;
        }
        if (body.websites) found.websites = body.websites;
        if (body.expiresAt !== undefined) found.expiresAt = body.expiresAt;
        for (const input of body.fields ?? []) {
          const existing = found.fields.find(
            (field) => field.id === input.fieldId || field.name === input.name,
          );
          if (input.remove && existing) {
            found.fields = found.fields.filter((field) => field !== existing);
            continue;
          }
          const value = input.generate ? generatePassword(input.generate) : input.value;
          if (existing) {
            existing.name = input.name ?? existing.name;
            if (value !== undefined) {
              existing.versions.push({ value, createdAt: new Date().toISOString(), by: "human" });
              existing.currentVersion = existing.versions.length;
              if (existing.kind === "text") existing.value = value;
              existing.updatedAt = new Date().toISOString();
            }
          } else {
            found.fields.push(
              ...fieldsFromInput(vault, found.name, [input]).map((field) => ({
                ...field,
                position: found.fields.length,
              })),
            );
          }
        }
        found.username = found.fields.find((field) => field.name === "username")?.value ?? null;
        found.hasTotp = found.fields.some((field) => field.kind === "totp");
        found.generation += 1;
        found.updatedAt = new Date().toISOString();
        return json(200, detail(found));
      },
    },
    {
      method: "DELETE",
      pattern: /\/vaults\/([^/]+)\/items\/([^/]+)$/,
      handle: (match, _body, url) => {
        const found = itemOf(match[1]!, match[2]!);
        if (!found) return fail(404, "vault_item_not_found", "Item not found.");
        if (url.searchParams.get("permanent") === "true") {
          state.items = state.items.filter((each) => each !== found);
        } else {
          found.archivedAt = new Date().toISOString();
        }
        refresh(state, match[1]!);
        return new Response(null, { status: 204 });
      },
    },
    {
      method: "POST",
      pattern: /\/vaults\/([^/]+)\/items\/([^/]+)\/restore$/,
      handle: (match) => {
        const found = itemOf(match[1]!, match[2]!);
        if (!found) return fail(404, "vault_item_not_found", "Item not found.");
        found.archivedAt = null;
        refresh(state, match[1]!);
        return json(200, detail(found));
      },
    },
    {
      method: "POST",
      pattern: /\/vaults\/([^/]+)\/items\/([^/]+)\/fields\/([^/]+)\/reveal$/,
      handle: (match, body) => {
        if (role() === "viewer") return fail(403, "vault_permission_denied", "Permission denied.");
        const found = itemOf(match[1]!, match[2]!);
        const field = found?.fields.find((each) => each.id === match[3]);
        if (!found || !field) return fail(404, "vault_field_not_found", "Field not found.");
        const version = typeof body?.version === "number" ? body.version : field.versions.length;
        const value = field.versions[version - 1]?.value ?? field.versions.at(-1)!.value;
        let totp = null;
        if (field.kind === "totp") {
          const params = parseTotpInput(value);
          const now = Date.now();
          totp = {
            code: totpCodeSync(params, now),
            periodSeconds: params.periodSeconds,
            expiresAt: new Date(now + totpRemainingMs(params, now)).toISOString(),
          };
        }
        return json(200, {
          value: field.kind === "file" ? btoa(value) : value,
          encoding: field.kind === "file" ? "base64" : "utf8",
          version: field.currentVersion === null ? null : version,
          totp,
        });
      },
    },
    {
      method: "GET",
      pattern: /\/vaults\/([^/]+)\/items\/([^/]+)\/fields\/([^/]+)\/versions$/,
      handle: (match) => {
        const found = itemOf(match[1]!, match[2]!);
        const field = found?.fields.find((each) => each.id === match[3]);
        if (!found || !field) return fail(404, "vault_field_not_found", "Field not found.");
        return json(200, {
          versions: field.versions
            .map((version, index) => ({
              version: index + 1,
              current: index === field.versions.length - 1,
              createdAt: version.createdAt,
              createdByKind: version.by,
              createdBySubjectId: null,
            }))
            .reverse(),
        });
      },
    },
    {
      method: "POST",
      pattern: /\/vaults\/([^/]+)\/items\/([^/]+)\/fields\/([^/]+)\/restore$/,
      handle: (match, body) => {
        const found = itemOf(match[1]!, match[2]!);
        const field = found?.fields.find((each) => each.id === match[3]);
        if (!found || !field) return fail(404, "vault_field_not_found", "Field not found.");
        const restored = field.versions[body.version - 1];
        if (restored) {
          field.versions.push({ ...restored, createdAt: new Date().toISOString(), by: "human" });
          field.currentVersion = field.versions.length;
          found.generation += 1;
        }
        return json(200, detail(found));
      },
    },
    {
      method: "GET",
      pattern: /\/sessions\/([^/]+)\/secrets$/,
      handle: (match) => sessionSecrets(match[1]!),
    },
    {
      method: "PUT",
      pattern: /\/sessions\/([^/]+)\/vault-policy$/,
      handle: (match, body) => {
        state.sessionPolicies[match[1]!] = body.policy;
        return sessionSecrets(match[1]!);
      },
    },
  ];
  function sessionSecrets(sessionId: string): Response {
    const active = scenarios();
    const inherited = active.has("inherited");
    const policy =
      state.sessionPolicies[sessionId] ??
      (active.has("narrowed") || inherited
        ? { mode: "selected" as const, vaultIds: [state.vaults[1]!.id, state.vaults[4]!.id] }
        : { mode: "all" as const });
    const reachable = state.vaults.filter((each) => each.ownerKind !== "task");
    const allowedByParent = inherited
      ? new Set([state.vaults[0]!.id, state.vaults[1]!.id, state.vaults[4]!.id])
      : null;
    const selected = (id: string) => policy.mode === "all" || policy.vaultIds.includes(id);
    const taskVault = state.vaults.find((each) => each.ownerKind === "task")!;
    return json(200, {
      capabilityEnabled: !active.has("capability-off"),
      policy,
      effectiveVaultIds: reachable.filter((each) => selected(each.id)).map((each) => each.id),
      narrowedBySessionId: inherited ? state.taskSessionId : null,
      taskVault: visibleVault(taskVault),
      taskItems: active.has("empty-task")
        ? []
        : state.items.filter((each) => each.vaultId === taskVault.id).map(summary),
      reachableVaults: reachable.map((each) => ({
        ...visibleVault(each),
        selected: selected(each.id) && (!allowedByParent || allowedByParent.has(each.id)),
        selectable: !allowedByParent || allowedByParent.has(each.id),
      })),
    });
  }
  return [
    ...first,
    {
      method: "POST",
      pattern: /\/connections\/1password\/install$/,
      handle: (_m, body) => {
        const token = String(body.token ?? "");
        if (token.includes("invalid"))
          return fail(400, "provider_auth_invalid", "Invalid service account token.");
        if (token.includes("expired")) return fail(401, "provider_auth_expired", "Token expired.");
        if (token.includes("rate"))
          return fail(429, "provider_rate_limited", "Rate limited.", {
            retryAt: new Date(MOCK_NOW + 20 * 60_000).toISOString(),
          });
        return json(201, {
          connectionId: mockId("op-connection"),
          accountName: "Acme (acme.1password.com)",
          vaults: [
            { externalVaultId: "op-eng", name: "Engineering", itemCount: 42, linkedVaultId: null },
            { externalVaultId: "op-mkt", name: "Marketing", itemCount: 7, linkedVaultId: null },
          ],
        });
      },
    },
    {
      method: "GET",
      pattern: /\/connections\/([^/]+)\/provider-vaults$/,
      handle: () =>
        json(200, {
          vaults: [
            { externalVaultId: "op-eng", name: "Engineering", itemCount: 42, linkedVaultId: null },
            { externalVaultId: "op-mkt", name: "Marketing", itemCount: 7, linkedVaultId: null },
          ],
        }),
    },
    {
      method: "POST",
      pattern: /\/connections\/([^/]+)\/managed-vaults$/,
      handle: (match, body) => {
        const base = state.vaults.find((each) => each.source === "onepassword")!;
        const created: VaultSummary = {
          ...base,
          id: mockId(`managed-${body.name}`),
          name: body.name,
          ownerKind: body.ownerKind,
          mode: "read_write",
          providerConnectionId: match[1]!,
          syncStatus: "ok",
          syncErrorCode: null,
          syncErrorMessage: null,
          itemCount: 0,
        };
        state.vaults.push(created);
        return json(201, visibleVault(created));
      },
    },
  ];
}

const WORKSPACE_PATH = /\/v1\/workspaces\/([^/]+)(\/.*)$/;
const WORKSPACE_READ = /\/v1\/workspaces(\/[^/]+)?$/;
const OWNED =
  /^\/(vaults(\/|$)|sessions\/[^/]+\/(secrets|vault-policy)$|connections\/(1password\/install|[^/]+\/(provider-vaults|managed-vaults))$)/;

/** "capability-off": the workspace's default agent has Secrets switched off. */
function withSecretsOff(workspace: unknown): unknown {
  if (!workspace || typeof workspace !== "object" || !("settings" in workspace)) return workspace;
  const settings = ((workspace as { settings?: Record<string, unknown> }).settings ?? {}) as Record<
    string,
    unknown
  >;
  const defaults = (settings.sessionAgentDefaults ?? {}) as Record<string, unknown>;
  return {
    ...workspace,
    settings: {
      ...settings,
      sessionAgentDefaults: { ...defaults, capabilities: { from: "all", secrets: false } },
    },
  };
}

async function patchWorkspaces(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const body = (await response.clone().json()) as unknown;
  const patched = Array.isArray(body)
    ? body.map(withSecretsOff)
    : body &&
        typeof body === "object" &&
        Array.isArray((body as { workspaces?: unknown }).workspaces)
      ? { ...body, workspaces: (body as { workspaces: unknown[] }).workspaces.map(withSecretsOff) }
      : withSecretsOff(body);
  return json(response.status, patched);
}

export function installSecretsMock(target: Window = window): void {
  const original = target.fetch.bind(target);
  target.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      target.location.href,
    );
    const match = url.pathname.match(WORKSPACE_PATH);
    if (
      scenarios().has("capability-off") &&
      WORKSPACE_READ.test(url.pathname) &&
      (init?.method ?? "GET").toUpperCase() === "GET"
    ) {
      return patchWorkspaces(await original(input, init));
    }
    if (!match || !OWNED.test(match[2]!)) return original(input, init);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const state = stateFor(match[1]!);
    const rest = match[2]!;
    const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    if (scenarios().has("slow")) await new Promise((resolve) => setTimeout(resolve, 600_000));
    for (const route of routes(state)) {
      if (route.method !== method) continue;
      const exact = rest.match(new RegExp(`^${route.pattern.source}`));
      if (exact) return await route.handle(exact, body, url);
    }
    return fail(404, "not_found", `No mock for ${method} ${rest}`);
  };
}
