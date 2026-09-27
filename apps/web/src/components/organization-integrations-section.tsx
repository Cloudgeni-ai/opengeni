import {
  getOrganizationIntegrationCatalog,
  getOrganizationIntegrationPolicy,
  updateOrganizationIntegrationPolicy,
  type OrganizationIntegrationCatalog,
  type OrganizationIntegrationPolicy,
  type UpdateOrganizationIntegrationPolicyRequest,
} from "@opengeni/sdk/organization-integration-policy";
import { useEffect, useRef, useState } from "react";
import { RowButton } from "@/components/models/models-ui";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { ListRow, ListRowSkeleton, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { Section, SectionStack } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { Toolbar, ToolbarSearch } from "@/components/ui/toolbar";
import {
  beginOrganizationAdminOperation,
  ownsOrganizationAdminOperation,
  organizationAdminIdentityKey,
  isOrganizationConflict,
  type OrganizationAdminIdentity,
  type OrganizationAdminOperation,
} from "@/lib/organization-admin";
import type { OrganizationMembershipRole } from "@/types";

type Props = {
  client: Parameters<typeof getOrganizationIntegrationPolicy>[0];
  identity: OrganizationAdminIdentity;
  actorRole: OrganizationMembershipRole | null;
  managedSession: boolean;
};

export function OrganizationIntegrationsSection(props: Props) {
  const authorized =
    props.managedSession && (props.actorRole === "owner" || props.actorRole === "admin");
  // Remount drafts on both identity and authorization changes, including direct consumers.
  return authorized ? (
    <IntegrationPolicyEditor key={organizationAdminIdentityKey(props.identity)} {...props} />
  ) : (
    <Notice tone="muted" title="Only owners and admins can change this">
      Ask an organization owner or admin to choose which integrations workspaces can connect.
    </Notice>
  );
}

function IntegrationPolicyEditor({ client, identity }: Props) {
  const [policy, setPolicy] = useState<OrganizationIntegrationPolicy | null>(null);
  const [catalog, setCatalog] = useState<OrganizationIntegrationCatalog | null>(null);
  const [mode, setMode] = useState<OrganizationIntegrationPolicy["mode"]>("unrestricted");
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [pending, setPending] = useState<UpdateOrganizationIntegrationPolicyRequest | null>(null);
  const [message, setMessage] = useState("");
  const currentIdentity = useRef<OrganizationAdminIdentity | null>(identity);
  const operation = useRef<OrganizationAdminOperation | null>(null);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const claim = (lane: "read" | "mutation") => {
    const accepted = beginOrganizationAdminOperation({
      identity,
      resource: "integrations",
      lane,
      previousSequence: sequence.current,
    });
    sequence.current = accepted.sequence;
    operation.current = accepted;
    return accepted;
  };
  const owns = (accepted: OrganizationAdminOperation) =>
    ownsOrganizationAdminOperation({
      currentIdentity: currentIdentity.current,
      currentOperation: operation.current,
      accepted,
    });
  const accept = (value: OrganizationIntegrationPolicy) => {
    setPolicy(value);
    setMode(value.mode);
    setSelected(value.allowedIntegrationKeys);
  };
  async function load() {
    const accepted = claim("read");
    setBusy(true);
    setError(null);
    try {
      const [value, options] = await Promise.all([
        getOrganizationIntegrationPolicy(client, identity.organizationId),
        getOrganizationIntegrationCatalog(client, identity.organizationId),
      ]);
      if (!owns(accepted)) return;
      accept(value);
      setCatalog(options);
      setConflict(false);
      setPermissionDenied(false);
      setMessage("");
    } catch {
      if (owns(accepted)) setError("Couldn't load integration settings. Try loading again.");
    } finally {
      if (owns(accepted)) setBusy(false);
    }
  }
  const initialLoad = useRef({ identity, load });
  useEffect(() => {
    currentIdentity.current = initialLoad.current.identity;
    void initialLoad.current.load();
    return () => {
      currentIdentity.current = null;
      operation.current = null;
    };
    // The wrapper remounts at identity/authorization boundaries. A refreshed client
    // object within that identity must not discard a draft or uncertain request.
  }, []);

  async function save() {
    if (!policy || inFlight.current || conflict || permissionDenied) return;
    const request = pending ?? {
      mode,
      allowedIntegrationKeys: mode === "restricted" ? [...selected].sort() : [],
      expectedRevision: policy.revision,
      operationId: crypto.randomUUID(),
    };
    inFlight.current = true;
    setPending(request);
    setBusy(true);
    setError(null);
    setMessage("");
    const accepted = claim("mutation");
    try {
      const value = await updateOrganizationIntegrationPolicy(
        client,
        identity.organizationId,
        request,
      );
      if (!owns(accepted)) return;
      accept(value);
      setPending(null);
      setMessage("Integration settings saved.");
    } catch (failure) {
      if (!owns(accepted)) return;
      const status =
        typeof failure === "object" && failure !== null && "status" in failure
          ? failure.status
          : undefined;
      if (status === 401 || status === 403) {
        setPending(null);
        setPermissionDenied(true);
        setError(
          "You no longer have permission to save these settings. Your draft is retained. Restore administrator access before refreshing.",
        );
      } else if (status === 400 || status === 422) {
        setPending(null);
        setError("These settings were not accepted. Review your selections before saving again.");
      } else if (isOrganizationConflict(failure)) {
        setPending(null);
        setConflict(true);
        setError(
          "These settings changed elsewhere. Your draft has not been overwritten. Refresh to discard this draft and review the latest settings before saving.",
        );
      } else {
        setError(
          "The save could not be confirmed. Your changes are retained. Retry the same save to safely confirm its outcome before making further edits.",
        );
      }
    } finally {
      if (owns(accepted)) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  const dirty =
    policy &&
    (mode !== policy.mode ||
      (mode === "restricted" &&
        JSON.stringify([...selected].sort()) !==
          JSON.stringify([...policy.allowedIntegrationKeys].sort())));
  const locked = busy || Boolean(pending) || conflict || permissionDenied;
  const query = search.trim().toLowerCase();
  const options = catalog?.integrations ?? [];
  const unknownKeys = selected.filter((key) => !options.some((item) => item.key === key));
  const rows = [
    ...options.map((item) => ({
      key: item.key,
      label: item.label,
      description: item.kind === "custom" ? "A connection your team sets up itself" : undefined,
    })),
    ...unknownKeys.map((key) => ({
      key,
      label: key,
      description: "No longer in the catalog",
    })),
  ];
  const shown = rows.filter((item) => `${item.label} ${item.key}`.toLowerCase().includes(query));
  const discard = () => {
    if (!policy) return;
    setMode(policy.mode);
    setSelected(policy.allowedIntegrationKeys);
    setMessage("");
  };
  const toggle = (key: string, allowed: boolean) => {
    setSelected((keys) =>
      allowed ? [...keys.filter((each) => each !== key), key] : keys.filter((each) => each !== key),
    );
    setMessage("");
  };

  if (!policy || !catalog) {
    return (
      <section aria-label="Integration policy" className="min-w-0">
        {error ? (
          <ErrorMessage
            variant="block"
            title="Couldn't load integration settings."
            announce
            action={
              <RowButton disabled={busy} onClick={() => void load()}>
                Try again
              </RowButton>
            }
          >
            Check your connection and try again.
          </ErrorMessage>
        ) : (
          <div role="status" aria-label="Loading integration settings…">
            <SettingRowGroup>
              <RowList label="Integrations" busy flush>
                <ListRowSkeleton count={3} />
              </RowList>
            </SettingRowGroup>
          </div>
        )}
      </section>
    );
  }

  return (
    <section aria-label="Integration policy" className="min-w-0">
      <SectionStack>
        <Section
          title="Allowed integrations"
          description="Applies to every workspace in the organization. Connections that already exist keep working."
        >
          <SettingRowGroup>
            <SettingRow
              label="Workspaces can connect"
              description={
                mode === "unrestricted"
                  ? "Any integration, including custom MCP, OpenAPI and GraphQL connections."
                  : "Only the integrations switched on below."
              }
              controlWidth="auto"
              control={
                <SegmentedControl<OrganizationIntegrationPolicy["mode"]>
                  size="sm"
                  aria-label="Allowed integrations"
                  disabled={locked}
                  value={mode}
                  onValueChange={(value) => {
                    setMode(value);
                    setMessage("");
                  }}
                  options={[
                    { value: "unrestricted", label: "All integrations" },
                    { value: "restricted", label: "Only selected" },
                  ]}
                />
              }
            />
          </SettingRowGroup>
        </Section>
        {mode === "restricted" ? (
          <Section
            title="Selected integrations"
            description={
              <span role="status">
                {selected.length} selected
                {selected.length === 0
                  ? ". Saving will block all new integration connections."
                  : ""}
              </span>
            }
          >
            <div className="flex min-w-0 flex-col gap-3">
              <Toolbar>
                <ToolbarSearch
                  value={search}
                  onValueChange={setSearch}
                  placeholder="Search integrations"
                  aria-label="Search integrations"
                />
              </Toolbar>
              {options.length === 0 && unknownKeys.length === 0 ? (
                <EmptyState
                  variant="inline"
                  title="No integrations are available in the catalog."
                />
              ) : shown.length === 0 ? (
                <EmptyState variant="inline" title={`No integration matches "${search.trim()}".`} />
              ) : (
                <RowList label="Integrations" flush>
                  {shown.map((item) => {
                    const allowed = selected.includes(item.key);
                    return (
                      <ListRow
                        key={item.key}
                        leading={<LogoTile name={item.label} />}
                        title={item.label}
                        description={item.description}
                        control={
                          <Switch
                            checked={allowed}
                            disabled={locked}
                            aria-label={`Allow ${item.label}`}
                            title={item.key}
                            onCheckedChange={(next) => toggle(item.key, next)}
                          />
                        }
                      />
                    );
                  })}
                </RowList>
              )}
            </div>
          </Section>
        ) : null}
      </SectionStack>
      {error ? (
        <div className="mt-6">
          <ErrorMessage
            variant="inline"
            title={error}
            announce
            action={
              conflict || permissionDenied ? (
                <RowButton disabled={busy} onClick={() => void load()}>
                  Discard draft and refresh
                </RowButton>
              ) : undefined
            }
          />
        </div>
      ) : null}
      {dirty || pending || message ? (
        <div className="sticky bottom-0 mt-6 flex min-w-0 flex-wrap items-center justify-end gap-3 border-t border-border bg-bg py-3">
          <p role="status" className="mr-auto min-w-0 text-xs leading-[18px] text-fg-muted">
            {message || (dirty && !pending && !conflict ? "Unsaved changes" : "")}
          </p>
          {dirty && !pending && !busy ? (
            <Button type="button" variant="ghost" onClick={discard} className="pointer-coarse:h-11">
              Cancel
            </Button>
          ) : null}
          {dirty || pending ? (
            <Button
              type="button"
              disabled={busy || conflict || permissionDenied || (!dirty && !pending)}
              onClick={() => void save()}
              className="pointer-coarse:h-11"
            >
              {busy ? "Saving…" : pending ? "Retry same save" : "Save changes"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
