export type ConnectOwnership = "personal" | "workspace";
export type ConnectProvider = {
  id: string;
  label: string;
  family: string;
  readiness: "available" | "needs_configuration" | "operator_only" | "unsupported";
  reason?: string;
  ownership: ConnectOwnership[];
  setup: Array<
    "none" | "oauth" | "credentials" | "device" | "installation" | "openapi" | "graphql"
  >;
};
export type ConnectAccount = {
  id: string;
  providerId: string;
  /** Observed credential generation; pass to disconnect to reject stale selections. */
  version?: number;
  label: string;
  ownership: ConnectOwnership;
  status: "connected" | "auth_needed" | "disabled";
};
export type ConnectResource = { id: string; label: string; kind: string };
export type ConnectInstallationTarget = {
  instanceKey: string;
  displayName: string;
  expectedInstanceVersion?: number;
};
export type ConnectNextAction =
  | { type: "authorize"; url: string }
  | {
      type: "credentials";
      fields: Array<{
        name: string;
        label: string;
        required: boolean;
        secret: boolean;
        options?: Array<{ value: string; label: string }>;
      }>;
    }
  | { type: "wait"; pollAfterMs: number; userCode?: string; verificationUrl?: string }
  | { type: "select_account"; accounts: ConnectAccount[] }
  | { type: "select_resources"; resources: ConnectResource[]; cursor?: string }
  | { type: "preview"; previewId: string; contentHash: string; operations: ConnectResource[] }
  | { type: "none" };
export type ConnectAttempt = {
  id: string;
  workspaceId: string;
  providerId: string;
  ownership: ConnectOwnership;
  revision: number;
  state:
    | "ready"
    | "requires_user_action"
    | "credential_input"
    | "provider_wait"
    | "account_selection"
    | "resource_selection"
    | "preview"
    | "installing"
    | "connected_but_incomplete"
    | "complete"
    | "cancelled"
    | "expired"
    | "failed"
    | "uncertain";
  credentialsCommitted: boolean;
  integrationInstalled: boolean;
  completionRequirement: "connection" | "integration" | "provider_setup";
  nextAction: ConnectNextAction;
  expiresAt: string;
  account?: ConnectAccount;
  installationTarget?: ConnectInstallationTarget;
  source?:
    | { kind: "definition"; definitionId: string }
    | { kind: "openapi" | "auto"; url: string; baseUrl?: string }
    | { kind: "graphql"; endpoint: string; name?: string };
  error?: { code: string; message: string; retryable: boolean };
};
export type ConnectAdvance =
  | { type: "credentials"; values: Record<string, string> }
  | { type: "account"; accountId: string }
  | { type: "resources"; resourceIds: string[] }
  | { type: "install"; previewId: string; contentHash: string; operationIds: string[] }
  | { type: "retry" };
export type ConnectCallOptions = { signal?: AbortSignal };

/** Host backend transport; authenticated workspace and actor admission stays
 * server-side. A controller never turns browser-supplied IDs into authority. */
export interface ConnectTransport {
  catalog(workspaceId: string, options?: ConnectCallOptions): Promise<ConnectProvider[]>;
  accounts(workspaceId: string, options?: ConnectCallOptions): Promise<ConnectAccount[]>;
  pending(workspaceId: string, options?: ConnectCallOptions): Promise<ConnectAttempt[]>;
  begin(
    workspaceId: string,
    input: {
      providerId: string;
      ownership: ConnectOwnership;
      returnUrl: string;
      idempotencyKey: string;
      reconnectAccountId?: string;
      installationTarget?: ConnectInstallationTarget;
    },
    options?: ConnectCallOptions,
  ): Promise<ConnectAttempt>;
  get(
    workspaceId: string,
    attemptId: string,
    options?: ConnectCallOptions,
  ): Promise<ConnectAttempt>;
  advance(
    workspaceId: string,
    attemptId: string,
    input: {
      expectedRevision: number;
      idempotencyKey: string;
      action: ConnectAdvance;
    },
    options?: ConnectCallOptions,
  ): Promise<ConnectAttempt>;
  cancel(
    workspaceId: string,
    attemptId: string,
    input: {
      expectedRevision: number;
      idempotencyKey: string;
    },
    options?: ConnectCallOptions,
  ): Promise<ConnectAttempt>;
  disconnect(
    workspaceId: string,
    accountId: string,
    options?: ConnectCallOptions & { expectedVersion?: number },
  ): Promise<void>;
}
