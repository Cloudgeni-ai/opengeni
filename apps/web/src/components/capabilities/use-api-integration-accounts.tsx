import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import type {
  IntegrationAccessItem,
  IntegrationChip,
  IntegrationFooter,
  IntegrationMark,
  IntegrationViewModel,
} from "@/components/capabilities/integration-view-model";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import type {
  ApiIntegrationInstallationSummary,
  ConnectionOwnership,
  IntegrationDefinitionSummary,
} from "@/types";

/**
 * The curated multi-instance ApiIntegration mechanism (Outlook Mail/Calendar/
 * Contacts, OneDrive, extra Google Drive accounts): every curated
 * `IntegrationDefinition` here is OAuth2-only, so adding an account is a
 * zero-dialog, straight-redirect action. This module is the one place that
 * knows the `definitionId`/`instanceKey`/OAuth-return-path plumbing; every
 * adapter that folds N accounts into one row builds on it.
 */

const CALLBACK_KEYS = [
  "integration_oauth",
  "api_integration_definition",
  "api_integration_instance",
  "api_integration_name",
  "api_integration_ownership",
  "api_integration_expected",
  "connectionId",
  "reason",
] as const;

type PendingApiIntegrationOAuth = {
  definitionId: string;
  instanceKey: string;
  displayName: string;
  ownership: ConnectionOwnership;
  expectedInstanceVersion?: number;
};

function apiIntegrationOAuthReturnPath(
  pathname: string,
  currentSearch: string,
  pending: PendingApiIntegrationOAuth,
): string {
  const params = new URLSearchParams(currentSearch);
  for (const key of CALLBACK_KEYS) params.delete(key);
  params.set("api_integration_definition", pending.definitionId);
  params.set("api_integration_instance", pending.instanceKey);
  params.set("api_integration_name", pending.displayName);
  params.set("api_integration_ownership", pending.ownership);
  if (pending.expectedInstanceVersion !== undefined) {
    params.set("api_integration_expected", String(pending.expectedInstanceVersion));
  }
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

function pendingApiIntegrationOAuth(search: string):
  | (PendingApiIntegrationOAuth & {
      outcome: string;
      connectionId: string | null;
      reason: string | null;
    })
  | null {
  const params = new URLSearchParams(search);
  const outcome = params.get("integration_oauth");
  const definitionId = params.get("api_integration_definition");
  const instanceKey = params.get("api_integration_instance");
  const displayName = params.get("api_integration_name");
  const ownership = params.get("api_integration_ownership");
  if (
    !outcome ||
    !definitionId ||
    !instanceKey ||
    !displayName ||
    (ownership !== "personal" && ownership !== "workspace")
  ) {
    return null;
  }
  const rawExpected = params.get("api_integration_expected");
  const expected = rawExpected ? Number(rawExpected) : undefined;
  return {
    outcome,
    definitionId,
    instanceKey,
    displayName,
    ownership,
    connectionId: params.get("connectionId"),
    reason: params.get("reason"),
    ...(expected !== undefined && Number.isInteger(expected) && expected > 0
      ? { expectedInstanceVersion: expected }
      : {}),
  };
}

/**
 * Handles the OAuth return for every curated multi-account ApiIntegration
 * definition. Mount exactly once (in the Capabilities route) regardless of how
 * many provider rows are on screen - the callback is keyed by definitionId in
 * the URL, not by which row started it.
 */
export function useApiIntegrationOAuthCallback({
  workspaceId,
  refresh,
  onRuntimeChanged,
}: {
  workspaceId: string;
  refresh: () => Promise<void>;
  onRuntimeChanged: () => void;
}) {
  const context = useAppContext();
  const client = context.client;
  const handled = useRef(false);
  const scopeRef = useRef({ client, workspaceId });
  scopeRef.current = { client, workspaceId };

  useEffect(() => {
    handled.current = false;
  }, [client, workspaceId]);

  useEffect(() => {
    if (handled.current) return;
    const pending = pendingApiIntegrationOAuth(window.location.search);
    if (!pending) return;
    handled.current = true;
    const cleaned = new URL(window.location.href);
    for (const key of CALLBACK_KEYS) cleaned.searchParams.delete(key);
    window.history.replaceState(null, "", `${cleaned.pathname}${cleaned.search}${cleaned.hash}`);
    if (pending.outcome !== "success" || !pending.connectionId) {
      toast.error("Connection wasn't completed", {
        description: pending.reason ?? "The provider did not return a usable account.",
      });
      return;
    }
    void (async () => {
      const scope = scopeRef.current;
      const source = { kind: "definition" as const, definitionId: pending.definitionId };
      const preview = await scope.client.previewApiIntegration(scope.workspaceId, {
        source,
        connectionId: pending.connectionId!,
        ownership: pending.ownership,
      });
      await scope.client.installApiIntegration(scope.workspaceId, {
        source,
        expectedRevisionId: preview.revisionId,
        expectedContentSha256: preview.contentSha256,
        connectionId: pending.connectionId!,
        ownership: pending.ownership,
        instanceKey: pending.instanceKey,
        displayName: pending.displayName,
        ...(pending.expectedInstanceVersion !== undefined
          ? { expectedInstanceVersion: pending.expectedInstanceVersion }
          : {}),
      });
      await refresh();
      onRuntimeChanged();
      toast.success(`${pending.displayName} is ready`, {
        description: `${preview.tools.length} tools are available through this exact account.`,
      });
    })().catch((error) => {
      toast.error("Connected, but couldn't finish setup", {
        description:
          error instanceof Error
            ? error.message
            : "Retry from this service's row; the connection remains safe.",
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);
}

export type ApiIntegrationAccountsController = {
  accounts: ApiIntegrationInstallationSummary[];
  accessItems: IntegrationAccessItem[];
  connected: boolean;
  needsAttention: boolean;
  busy: boolean;
  /** Zero-dialog: every curated definition here is oauth2-reviewed. */
  addAccount: () => void;
  /** Every account's currently discovered tool names, deduplicated. */
  tools: string[];
};

/**
 * One provider's account roster folded from the curated ApiIntegration
 * mechanism: N `ApiIntegrationInstallationSummary` rows sharing one
 * `definitionId` become one row's rolled-up chip plus one "Connected
 * accounts" Access-block item per account.
 */
export function useApiIntegrationAccounts({
  workspaceId,
  definitionId,
  definitions,
  instances,
  canManage,
  ownership = "workspace",
}: {
  workspaceId: string;
  definitionId: string;
  definitions: IntegrationDefinitionSummary[];
  instances: ApiIntegrationInstallationSummary[];
  canManage: boolean;
  ownership?: ConnectionOwnership;
}): ApiIntegrationAccountsController {
  const context = useAppContext();
  const client = context.client;
  const [busy, setBusy] = useState(false);
  const definition = definitions.find((candidate) => candidate.id === definitionId) ?? null;
  const accounts = instances.filter((instance) => instance.definitionId === definitionId);

  async function startAdd(existing: ApiIntegrationInstallationSummary | null) {
    if (!definition || !canManage) return;
    setBusy(true);
    try {
      const instanceKey = existing?.instanceKey ?? `account-${crypto.randomUUID()}`;
      const displayName = existing
        ? existing.displayName
        : accounts.length === 0
          ? definition.name
          : `${definition.name} - Account ${accounts.length + 1}`;
      const returnPath = apiIntegrationOAuthReturnPath(
        window.location.pathname,
        window.location.search,
        {
          definitionId,
          instanceKey,
          displayName,
          ownership,
          ...(existing ? { expectedInstanceVersion: existing.instanceVersion } : {}),
        },
      );
      const response = await client.startApiIntegrationOAuth(workspaceId, {
        definitionId,
        ownership,
        returnPath,
        ...(existing?.connectionId ? { connectionId: existing.connectionId } : {}),
      });
      if (!response.authorizationUrl) throw new Error("The provider did not return a consent URL.");
      window.location.assign(response.authorizationUrl);
    } catch (error) {
      setBusy(false);
      toast.error("Couldn't start account connection", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const accessItems: IntegrationAccessItem[] = accounts.map((account) => ({
    name: account.displayName,
    meta: account.connected ? undefined : "Needs attention",
    status: account.connected ? "ok" : "warn",
    ...(canManage && !account.connected
      ? { action: { label: "Reconnect", onClick: () => void startAdd(account) } }
      : {}),
  }));

  const tools = [...new Set(accounts.flatMap((account) => account.allowedTools))];

  return {
    accounts,
    accessItems,
    connected: accounts.some((account) => account.connected),
    needsAttention: accounts.length > 0 && accounts.some((account) => !account.connected),
    busy,
    addAccount: () => void startAdd(null),
    tools,
  };
}

export type IntegrationAdapter = { model: IntegrationViewModel; dialogs: ReactNode };

/**
 * Builds a full one-row-per-provider `IntegrationAdapter` around
 * {@link useApiIntegrationAccounts} for a curated multi-account definition
 * that has no other integration-specific state (Outlook Mail/Calendar/
 * Contacts, OneDrive). Every account lives in the "Connected accounts" Access
 * block; once at least one account exists the footer defers to it instead of
 * offering an ambiguous whole-row Reconnect/Disconnect.
 */
export function useIntegrationDefinitionRow({
  id,
  name,
  description,
  mark,
  definitionId,
  workspaceId,
  definitions,
  instances,
}: {
  id: string;
  name: string;
  description: string;
  mark: IntegrationMark;
  definitionId: string;
  workspaceId: string;
  definitions: IntegrationDefinitionSummary[];
  instances: ApiIntegrationInstallationSummary[];
}): IntegrationAdapter {
  const context = useAppContext();
  const canManage = hasWorkspacePermission(context.accessContext, workspaceId, "workspace:admin");
  const controller = useApiIntegrationAccounts({
    workspaceId,
    definitionId,
    definitions,
    instances,
    canManage,
  });

  const chip: IntegrationChip =
    controller.accounts.length === 0
      ? canManage
        ? { label: "Not connected", tone: "idle" }
        : { label: "Set up by an admin", tone: "plain" }
      : controller.needsAttention
        ? { label: "Needs attention", tone: "warn" }
        : { label: "Connected", tone: "ok" };

  const footer: IntegrationFooter =
    controller.accounts.length === 0
      ? canManage
        ? { kind: "setup", onSetup: controller.addAccount, busy: controller.busy }
        : { kind: "locked" }
      : {
          kind: "locked",
          message: canManage
            ? "Manage individual accounts in Connected accounts above."
            : "A workspace administrator manages these accounts.",
        };

  const model: IntegrationViewModel = {
    id,
    name,
    description,
    mark,
    chip,
    connection: [],
    ...(controller.accounts.length > 0
      ? {
          access: {
            title: "Connected accounts",
            items: controller.accessItems,
            ...(canManage
              ? {
                  editLabel: "+ Add account",
                  onEdit: controller.addAccount,
                  editDisabled: controller.busy,
                }
              : {}),
          },
        }
      : {}),
    options: [],
    footer,
    ...(controller.tools.length > 0 ? { tools: { tools: controller.tools } } : {}),
  };

  return { model, dialogs: null };
}
