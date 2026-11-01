import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CloudOffIcon,
  Loader2Icon,
  RefreshCwIcon,
  RotateCwIcon,
  KeyRoundIcon,
  PowerIcon,
  Trash2Icon,
} from "lucide-react";

import { Badge } from "@opengeni/react/ui/badge";
import { Button } from "@opengeni/react/ui/button";
import {
  customApiConnectionLabel,
  connectionOwnership,
} from "@/components/capabilities/custom-api-flow";
import { organizationApiKeyNoun } from "@/components/capabilities/organization-api-key-dialog";
import type {
  ApiIntegrationInstallationSummary,
  ConnectionMetadata,
} from "@opengeni/react/app/types";

export function CustomApiSection({
  instances,
  connections,
  canAdd,
  canManage,
  canChange,
  busyKey,
  onConnect,
  onUpdate,
  onReconnect,
  onRemove,
  onAddOwnKey,
  onSetOrganizationHere,
}: {
  instances: ApiIntegrationInstallationSummary[];
  connections: ConnectionMetadata[] | null;
  /** Connect a new custom API (members, unless their organization keeps it for admins). */
  canAdd: boolean;
  /** Remove an instance. */
  canManage: boolean;
  /** Reconnect or update an instance that is already set up (integration admins). */
  canChange: boolean;
  busyKey: string | null;
  onConnect: () => void;
  onUpdate: (instance: ApiIntegrationInstallationSummary) => void;
  onReconnect: (instance: ApiIntegrationInstallationSummary) => void;
  onRemove: (instance: ApiIntegrationInstallationSummary) => void;
  /** An organization API where each person signs in: add the person's own key. */
  onAddOwnKey: (instance: ApiIntegrationInstallationSummary) => void;
  /** An organization API: turn it off in this workspace, or back on. */
  onSetOrganizationHere: (
    instance: ApiIntegrationInstallationSummary,
    enabledHere: boolean,
  ) => void;
}) {
  const connectionById = new Map(
    (connections ?? []).map((connection) => [connection.id, connection]),
  );
  return (
    <section
      className="border-t border-border/80 px-4 py-5 sm:px-6"
      aria-labelledby="custom-apis-heading"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="custom-apis-heading" className="text-sm font-semibold text-fg">
              Custom APIs
            </h3>
            <Badge variant="outline" className="bg-bg text-2xs text-fg transition-none">
              OpenAPI + GraphQL
            </Badge>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-fg-muted">
            Every named instance keeps its own runtime identity, Connection, tool policy, revision,
            and removal boundary.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          className="pointer-coarse:min-h-11"
          onClick={onConnect}
          disabled={!canAdd || busyKey !== null}
        >
          Connect custom API
        </Button>
      </div>

      {instances.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-border bg-bg/40 p-5 text-sm text-fg-muted">
          Paste a URL or domain. Opengeni detects OpenAPI or GraphQL, shows the immutable revision,
          tools, permissions, warnings, ownership, and account label before installation.
        </div>
      ) : (
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          {instances.map((instance) => {
            const organization = instance.organizationConnector;
            const ownKey = organizationApiOwnConnection(instance, connections);
            const connection = instance.connectionId
              ? connectionById.get(instance.connectionId)
              : (ownKey ?? undefined);
            const status = organization
              ? organizationApiStatus(instance, ownKey)
              : customApiInstanceStatus(instance, connections, connection);
            return (
              <article
                key={instance.instanceId}
                className="rounded-xl border border-border bg-bg/50 p-4 shadow-xs"
                data-custom-api-instance={instance.instanceKey}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusIcon status={status.kind} />
                      <h4 className="truncate text-sm font-semibold text-fg">
                        {instance.displayName}
                      </h4>
                      <Badge variant="outline" className="text-2xs uppercase text-fg-subtle">
                        {instance.protocol}
                      </Badge>
                    </div>
                    <p className="mt-1 break-all text-2xs text-fg-subtle">
                      {instance.providerDomain} · {instance.toolCount} enabled tools
                    </p>
                    {instance.personalExtension ? (
                      <p className="mt-1 text-2xs text-fg-muted">
                        From {instance.personalExtension.originWorkspaceName}
                      </p>
                    ) : organization ? (
                      <p className="mt-1 text-2xs text-fg-muted">
                        From your organization{organization.enabledHere ? "" : " · Off here"}
                      </p>
                    ) : null}
                  </div>
                  {busyKey === instance.instanceKey ? (
                    <Loader2Icon
                      className="size-4 shrink-0 animate-spin text-brand"
                      aria-label="Working"
                    />
                  ) : null}
                </div>

                <dl className="mt-3 grid gap-2 rounded-lg border border-border/80 bg-surface/50 p-3 text-2xs sm:grid-cols-2">
                  <Fact label="Status" value={status.label} />
                  <Fact
                    label="Owner"
                    value={
                      organization
                        ? "Your organization"
                        : instance.ownership === "personal"
                          ? "Personal"
                          : instance.ownership === "workspace"
                            ? "Workspace"
                            : "Workspace · no credential"
                    }
                  />
                  <Fact
                    label="Account"
                    value={
                      organization?.login === "organization_key"
                        ? "The organization's key"
                        : organization?.login === "each_person" && !connection
                          ? `Your own ${organizationApiKeyNoun(instance)}, once you add it`
                          : connection
                            ? customApiConnectionLabel(connection)
                            : instance.requiresConnection
                              ? connections === null
                                ? "Connection data unavailable"
                                : "Connection unavailable"
                              : "Anonymous / no authentication"
                    }
                  />
                  <Fact
                    label="Revision"
                    value={`${instance.revisionId} · ${instance.contentSha256.slice(0, 12)}…`}
                    mono
                  />
                </dl>

                {/* An instance carried in from another workspace is managed there;
                    an organization's is managed in the organization's settings. */}
                {instance.personalExtension ? null : organization ? (
                  <div className="mt-3 flex flex-col gap-2">
                    <p className="m-0 text-2xs leading-4.5 text-fg-muted">
                      Your organization manages it in its settings.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {organization.login === "each_person" &&
                      organization.enabledHere &&
                      !ownKey ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className="pointer-coarse:min-h-11"
                          disabled={busyKey !== null}
                          onClick={() => onAddOwnKey(instance)}
                        >
                          <KeyRoundIcon />
                          {`Add your ${organizationApiKeyNoun(instance)}`}
                        </Button>
                      ) : null}
                      {canChange ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="pointer-coarse:min-h-11"
                          disabled={busyKey !== null}
                          onClick={() => onSetOrganizationHere(instance, !organization.enabledHere)}
                        >
                          <PowerIcon />
                          {organization.enabledHere ? "Turn off here" : "Turn on here"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {instance.requiresConnection ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        className="pointer-coarse:min-h-11"
                        disabled={!canChange || busyKey !== null}
                        onClick={() => onReconnect(instance)}
                      >
                        <RotateCwIcon />
                        Reconnect
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="pointer-coarse:min-h-11"
                      disabled={!canChange || busyKey !== null}
                      onClick={() => onUpdate(instance)}
                    >
                      <RefreshCwIcon />
                      Check for updates
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="pointer-coarse:min-h-11"
                      disabled={!canManage || busyKey !== null}
                      onClick={() => onRemove(instance)}
                    >
                      <Trash2Icon />
                      Remove
                    </Button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * The person's own account an organization's "each person signs in" API runs
 * through here: their active Only me connection to its provider, of the kind
 * its authentication takes.
 */
export function organizationApiOwnConnection(
  instance: ApiIntegrationInstallationSummary,
  connections: ConnectionMetadata[] | null,
): ConnectionMetadata | null {
  const organization = instance.organizationConnector;
  if (!organization || organization.login !== "each_person" || !connections) return null;
  const kind = organization.auth.kind === "oauth2" ? "oauth2" : "api_key";
  return (
    connections.find(
      (connection) =>
        connection.status === "active" &&
        connection.subjectId !== null &&
        connection.kind === kind &&
        connection.providerDomain.toLowerCase() === instance.providerDomain.toLowerCase(),
    ) ?? null
  );
}

export function organizationApiStatus(
  instance: ApiIntegrationInstallationSummary,
  ownKey: ConnectionMetadata | null,
): { kind: "ready" | "attention" | "unavailable"; label: string } {
  const organization = instance.organizationConnector!;
  if (!organization.enabledHere) return { kind: "unavailable", label: "Off in this workspace" };
  if (organization.login === "none") return { kind: "ready", label: "Ready · no authentication" };
  if (organization.login === "organization_key")
    return { kind: "ready", label: "Ready · organization key" };
  return ownKey
    ? { kind: "ready", label: "Ready · your own account" }
    : { kind: "attention", label: `Add your ${organizationApiKeyNoun(instance)} to use it` };
}

function customApiInstanceStatus(
  instance: ApiIntegrationInstallationSummary,
  connections: ConnectionMetadata[] | null,
  connection: ConnectionMetadata | undefined,
): { kind: "ready" | "attention" | "unavailable"; label: string } {
  if (!instance.requiresConnection) return { kind: "ready", label: "Ready · no authentication" };
  if (connections === null) return { kind: "unavailable", label: "Connection status unavailable" };
  if (!connection) return { kind: "attention", label: "Reconnect required" };
  if (connectionOwnership(connection) !== instance.ownership) {
    return { kind: "attention", label: "Connection ownership mismatch" };
  }
  if (connection.status === "active") return { kind: "ready", label: "Ready" };
  return {
    kind: "attention",
    label: connection.status === "needs_reauth" ? "Reconnect required" : "Connection unavailable",
  };
}

function StatusIcon({ status }: { status: "ready" | "attention" | "unavailable" }) {
  if (status === "ready")
    return <CheckCircle2Icon className="size-4 shrink-0 text-status-success" />;
  if (status === "unavailable") return <CloudOffIcon className="size-4 shrink-0 text-fg-subtle" />;
  return <AlertTriangleIcon className="size-4 shrink-0 text-status-waiting" />;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="font-medium text-fg-subtle">{label}</dt>
      <dd
        className={
          mono ? "mt-0.5 break-all font-mono text-fg-muted" : "mt-0.5 break-words text-fg-muted"
        }
      >
        {value}
      </dd>
    </div>
  );
}
