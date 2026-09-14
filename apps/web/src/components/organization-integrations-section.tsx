import {
  getOrganizationIntegrationCatalog,
  getOrganizationIntegrationPolicy,
  updateOrganizationIntegrationPolicy,
  type OrganizationIntegrationCatalog,
  type OrganizationIntegrationPolicy,
  type UpdateOrganizationIntegrationPolicyRequest,
} from "@opengeni/sdk/organization-integration-policy";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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
    <p className="text-sm text-fg-muted">
      Only organization owners and administrators using an organization administrator session can
      manage integrations.
    </p>
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
  const groups = [
    { title: "Catalog integrations", items: options.filter((item) => item.kind === "curated") },
    { title: "Custom integrations", items: options.filter((item) => item.kind === "custom") },
    {
      title: "Previously selected keys",
      items: unknownKeys.map((key) => ({ key, label: "Not in the current catalog" })),
    },
  ];
  return (
    <section
      className="grid min-w-0 gap-5 border-b border-border pb-6"
      aria-label="Integration policy"
    >
      <p className="max-w-2xl text-sm leading-6 text-fg-muted">
        This policy applies to all organization workspaces. Existing connections remain connected
        and manageable; it controls which integrations can be newly connected.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-fg">
          {error}
        </p>
      ) : null}
      {!policy || !catalog ? (
        busy ? (
          <p role="status" className="text-sm text-fg-muted">
            Loading integration settings…
          </p>
        ) : (
          <Button variant="secondary" onClick={() => void load()}>
            Try loading again
          </Button>
        )
      ) : (
        <>
          <label className="grid gap-2 text-sm font-medium">
            Allowed integrations
            <Select
              value={mode}
              disabled={locked}
              onChange={(event) => {
                setMode(event.target.value as typeof mode);
                setMessage("");
              }}
            >
              <option value="unrestricted">Unrestricted — allow all integrations</option>
              <option value="restricted">Selected integrations only</option>
            </Select>
          </label>
          <p className="text-sm text-fg-muted">
            {mode === "unrestricted"
              ? "All catalog integrations and custom MCP, OpenAPI, and GraphQL connections are allowed."
              : "Only selected integrations are allowed. Custom MCP, OpenAPI, and GraphQL must each be explicitly selected below."}
          </p>
          <div className="grid gap-2">
            <label htmlFor="integration-policy-search" className="text-sm font-medium">
              Search integrations by name or stable key
            </label>
            <Input
              id="integration-policy-search"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <p role="status" className="text-xs text-fg-muted">
              {mode === "restricted" ? `${selected.length} selected` : "All integrations allowed"}
            </p>
            {mode === "restricted" && selected.length === 0 ? (
              <p className="text-sm text-fg">
                No integrations selected. Saving will block all new integration connections.
              </p>
            ) : null}
          </div>
          {groups.map((group) => {
            const filtered = group.items.filter((item) =>
              `${item.label} ${item.key}`.toLowerCase().includes(query),
            );
            if (!group.items.length) return null;
            return (
              <fieldset key={group.title} className="min-w-0">
                <legend className="mb-2 text-sm font-medium">{group.title}</legend>
                <div className="grid max-h-80 gap-1 overflow-y-auto">
                  {filtered.map((item) => (
                    <label
                      key={item.key}
                      className="flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-bg-subtle focus-within:ring-2 focus-within:ring-brand"
                    >
                      <input
                        type="checkbox"
                        className="mt-1 size-4 shrink-0 accent-brand"
                        disabled={locked || mode === "unrestricted"}
                        checked={mode === "unrestricted" || selected.includes(item.key)}
                        onChange={(event) => {
                          setSelected((keys) =>
                            event.target.checked
                              ? [...keys, item.key]
                              : keys.filter((key) => key !== item.key),
                          );
                          setMessage("");
                        }}
                      />
                      <span className="grid min-w-0 gap-1 text-sm">
                        <span>{item.label}</span>
                        <code className="select-text break-all text-xs text-fg-muted">
                          {item.key}
                        </code>
                      </span>
                    </label>
                  ))}
                  {!filtered.length ? (
                    <p className="text-sm text-fg-muted">No matching integrations in this group.</p>
                  ) : null}
                </div>
              </fieldset>
            );
          })}
          {!options.length ? (
            <p className="text-sm text-fg-muted">No integrations are available in the catalog.</p>
          ) : null}
          <p className="text-xs text-fg-muted">
            Stable keys are shown below each name and can be selected and copied.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              disabled={busy || conflict || permissionDenied || (!dirty && !pending)}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : pending ? "Retry same save" : "Save changes"}
            </Button>
            {conflict || permissionDenied ? (
              <Button variant="secondary" disabled={busy} onClick={() => void load()}>
                Discard draft and refresh
              </Button>
            ) : null}
            <p role="status" className="text-sm text-fg-muted">
              {message || (dirty && !pending && !conflict ? "Unsaved changes" : "")}
            </p>
          </div>
        </>
      )}
    </section>
  );
}
