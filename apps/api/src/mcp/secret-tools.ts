/**
 * The agent's `secret_*` tools (capability `secrets`). They act with the exact
 * live attempt's vault reach, return references and metadata, and never echo
 * a value; `secret_get` is the one plaintext read and needs a literal
 * `secrets:read` grant. Registration is gated centrally by
 * FIRST_PARTY_TOOL_AUTHORIZATION and the session's signed tool selection, so
 * with the capability off none of these tools exist.
 */
import {
  SecretDeleteInput,
  SecretGetInput,
  SecretMoveInput,
  SecretSaveInput,
  SecretSearchInput,
  type AccessGrant,
  type SecretPrincipal,
} from "@opengeni/contracts";
import {
  createVaultService,
  hasLiteralPermission,
  isVaultError,
  requireLiveAgentAttemptAuthorization,
  siteAgentClamp,
  siteClampedAgentMessage,
  vaultErrorCodeForProvider,
  vaultErrorFromDatabase,
  type ApiRouteDeps,
  type VaultService,
} from "@opengeni/core";
import { environmentsEncryptionKeyBytes } from "@opengeni/config";
import { isVaultProviderError } from "@opengeni/vaults";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { vaultProviderRegistryFor } from "../routes/vault-providers";

type AttemptPrincipal = Extract<SecretPrincipal, { kind: "attempt" }>;

function toolError(code: string, message: string, details?: Record<string, unknown>) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: { code, message, ...(details ? { details } : {}) } }),
      },
    ],
  };
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function registerSecretTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  options: { vaults?: (subjectId: string | null) => VaultService } = {},
): void {
  // Vault reach is the live attempt's; humans and operators use the vault API.
  if (grant.principalKind !== "agent_attempt") return;
  // Connected vaults (1Password, host) read and write under the acting human,
  // the same subject the worker's attempt resolver uses.
  const services = new Map<string, VaultService>();
  const vaults =
    options.vaults ??
    ((subjectId: string | null) => {
      const key = subjectId ?? "";
      let service = services.get(key);
      if (!service) {
        service = createVaultService({
          db: deps.db,
          encryptionKey: environmentsEncryptionKeyBytes(deps.settings) ?? null,
          providers: vaultProviderRegistryFor(deps, { workspaceId: grant.workspaceId, subjectId }),
        });
        services.set(key, service);
      }
      return service;
    });

  async function run(
    fn: (principal: AttemptPrincipal, service: VaultService) => Promise<unknown>,
    mode: "read" | "write" = "read",
  ) {
    // An agent started from a Site page uses saved secrets by reference but
    // never saves, moves or archives them.
    if (mode === "write" && (await siteAgentClamp(deps.db, grant))?.clamped)
      return toolError("site_agent_clamped", siteClampedAgentMessage("secrets"));
    try {
      const attempt = await requireLiveAgentAttemptAuthorization(deps.db, grant, sessionId);
      const principal: AttemptPrincipal = {
        kind: "attempt",
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId: attempt.callerSessionId,
        turnId: attempt.turnId,
        attemptId: attempt.attemptId,
        executionGeneration: attempt.executionGeneration,
      };
      return result(await fn(principal, vaults(attempt.initiatingHumanSubjectId)));
    } catch (error) {
      if (isVaultProviderError(error)) {
        return toolError(vaultErrorCodeForProvider(error.code, "write"), error.message, {
          ...(error.retryAfterMs
            ? { retryAt: new Date(Date.now() + error.retryAfterMs).toISOString() }
            : {}),
        });
      }
      const vaultError = isVaultError(error) ? error : vaultErrorFromDatabase(error);
      if (vaultError) return toolError(vaultError.code, vaultError.message, vaultError.details);
      throw error;
    }
  }

  server.registerTool(
    "secret_search",
    {
      description:
        "Find saved logins, API keys and other secrets you can use. Returns items with their vault, website, username, field names and ready references such as {{secret:Vault/Item/password}} and {{secret:Vault/Item/otp}}; never values. Search by name, website (for example the login page's domain) or type before signing in or asking anyone for a secret. With no filters it lists everything you can use. The first page also lists every vault you can reach with its item count; when `nextCursor` is set, call again with the same filters and that `cursor` for the next page.",
      inputSchema: SecretSearchInput.shape,
    },
    (input) =>
      run((principal, service) =>
        service.searchForAgent(principal, SecretSearchInput.parse(input)),
      ),
  );

  server.registerTool(
    "secret_save",
    {
      description:
        'Save or update a secret item (login, API key, note) and get its references back. For a new password use a field with `generate` (for example {name: "password", generate: {length: 24}}) and save it before typing it anywhere; copy an existing secret with `fromReference`. Put a username in `username`. saveTo picks the vault: user (Only me), task (this task) or workspace; it defaults to Only me when a person started this work, otherwise the workspace. Values are never echoed; avoid putting a literal `value` here unless the task gave you that exact value.',
      inputSchema: SecretSaveInput.shape,
    },
    (input) =>
      run(
        (principal, service) => service.saveForAgent(principal, SecretSaveInput.parse(input)),
        "write",
      ),
  );

  if (hasLiteralPermission(grant.permissions, "secrets:read")) {
    server.registerTool(
      "secret_get",
      {
        description:
          "Read one secret's plaintext value. This is a high-trust, audited read: use it only when the task needs the value itself and a {{secret:...}} reference cannot be used where it runs.",
        inputSchema: SecretGetInput.shape,
      },
      (input) =>
        run((principal, service) =>
          service.readForAgent(principal, SecretGetInput.parse(input), grant.permissions),
        ),
    );
  }

  server.registerTool(
    "secret_move",
    {
      description:
        "Move or copy a saved item to another vault you can write (for example from this task's vault to Only me or the workspace). Returns the item's new references.",
      inputSchema: SecretMoveInput.shape,
    },
    (input) =>
      run(
        (principal, service) => service.moveForAgent(principal, SecretMoveInput.parse(input)),
        "write",
      ),
  );

  server.registerTool(
    "secret_delete",
    {
      description:
        "Archive a saved item you no longer need. A person can restore it from the vault's archived items.",
      inputSchema: SecretDeleteInput.shape,
    },
    (input) =>
      run(
        (principal, service) => service.archiveForAgent(principal, SecretDeleteInput.parse(input)),
        "write",
      ),
  );
}
