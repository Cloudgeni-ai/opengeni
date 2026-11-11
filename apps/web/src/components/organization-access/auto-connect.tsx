import type {
  CheckMcpTrustedIssuerRequest,
  CheckMcpTrustedIssuerResponse,
  CreateMcpTrustedIssuerRequest,
  ListMcpTrustedIssuerEventsResponse,
  ListMcpTrustedIssuersResponse,
  McpAutoConnectRefusalReason,
  McpTrustedIssuer,
  McpTrustedIssuerEvent,
  McpTrustedIssuerProvider,
  UpdateMcpTrustedIssuerRequest,
} from "@opengeni/contracts";
import { CircleCheckIcon, KeyRoundIcon, PowerIcon, PowerOffIcon, TrashIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import {
  OrganizationAccessFields,
  type AccessWorkspace,
} from "@/components/organization-access/organization-access-fields";
import {
  defaultPolicy,
  policyBlockedReason,
  policySummary,
  scopeSummary,
  type OrganizationAccessPolicy,
} from "@/lib/organization-access";
import { ProviderTile } from "@opengeni/react/app/components/models/provider-mark";
import { DestructiveConfirm } from "@opengeni/react/app/components/ui/destructive-confirm";
import {
  apiErrorDetails,
  userErrorText,
  userErrorTextWithoutReference,
} from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { ChoiceCard, ChoiceCards } from "@opengeni/react/ui/choice-cards";
import { CopyField } from "@opengeni/react/ui/copy-field";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@opengeni/react/ui/detail-page";
import { DetailSection } from "@opengeni/react/ui/detail-sheet";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { Field, FieldStack, TextArea, TextInput } from "@opengeni/react/ui/field";
import { FLUSH_DETAIL_PAGE_CLASS, FlushFormPage } from "@opengeni/react/ui/flush-form-page";
import { FormDisclosure } from "@opengeni/react/ui/form-disclosure";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@opengeni/react/ui/list-row";
import { LogoTile, type LogoTileSize } from "@opengeni/react/ui/logo-tile";
import { Notice } from "@opengeni/react/ui/notice";
import { MoreMenu, RowButton } from "@opengeni/react/ui/page-actions";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { Section } from "@opengeni/react/ui/section";
import { StatusBadge } from "@opengeni/react/ui/status-badge";

/* ----------------------------------------------------------------------------
   Organization settings > Connected agents > Auto-connect.

   An admin trusts an issuer of identity assertions (ID-JAGs): Claude's own
   issuer for the organization, or the identity provider people sign in to
   their AI app with. Every member that issuer vouches for is then connected
   to the organization MCP server the first time their app uses it, with no
   sign-in, as themselves and with the access set here.

     agents section          the issuers, or one action to set it up
     issuer=new              set up: where to paste what, then access
     issuer=<id>             an issuer: status, access, recent attempts
   -------------------------------------------------------------------------- */

export type AutoConnectApi = {
  list: () => Promise<ListMcpTrustedIssuersResponse>;
  check: (request: CheckMcpTrustedIssuerRequest) => Promise<CheckMcpTrustedIssuerResponse>;
  create: (request: CreateMcpTrustedIssuerRequest) => Promise<McpTrustedIssuer>;
  update: (id: string, request: UpdateMcpTrustedIssuerRequest) => Promise<McpTrustedIssuer>;
  remove: (id: string) => Promise<void>;
  events: (id: string) => Promise<ListMcpTrustedIssuerEventsResponse>;
};

export type TrustedIssuers = {
  /** Null while loading. */
  list: ListMcpTrustedIssuersResponse | null;
  error: Error | null;
  refresh: () => Promise<void>;
  accept: (next: McpTrustedIssuer) => void;
  drop: (id: string) => void;
};

export function useTrustedIssuers(api: AutoConnectApi | null): TrustedIssuers {
  const [state, setState] = useState<{
    list: ListMcpTrustedIssuersResponse | null;
    error: Error | null;
  }>({ list: null, error: null });
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    if (!api) return;
    const current = ++sequence.current;
    try {
      const list = await api.list();
      if (sequence.current === current) setState({ list, error: null });
    } catch (caught) {
      if (sequence.current === current)
        setState((previous) => ({
          ...previous,
          error: caught instanceof Error ? caught : new Error(String(caught)),
        }));
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current += 1;
    };
  }, [refresh]);
  const accept = useCallback((next: McpTrustedIssuer) => {
    setState((previous) => {
      if (!previous.list) return previous;
      const known = previous.list.trustedIssuers.some((each) => each.id === next.id);
      return {
        ...previous,
        list: {
          ...previous.list,
          trustedIssuers: known
            ? previous.list.trustedIssuers.map((each) => (each.id === next.id ? next : each))
            : [...previous.list.trustedIssuers, next],
        },
      };
    });
  }, []);
  const drop = useCallback((id: string) => {
    setState((previous) =>
      previous.list
        ? {
            ...previous,
            list: {
              ...previous.list,
              trustedIssuers: previous.list.trustedIssuers.filter((each) => each.id !== id),
            },
          }
        : previous,
    );
  }, []);
  return { ...state, refresh, accept, drop };
}

/* --------------------------------- Words --------------------------------- */

const PROVIDERS: Record<
  McpTrustedIssuerProvider,
  { label: string; kind: string; description: string; placeholder: string }
> = {
  claude: {
    label: "Claude",
    kind: "Claude-issued",
    description: "Everyone in your Claude Team or Enterprise organization.",
    placeholder: "https://identity.anthropic.com/issuers/…",
  },
  okta: {
    label: "Okta",
    kind: "Okta",
    description: "People who sign in to Claude or another AI app through Okta.",
    placeholder: "https://example.okta.com",
  },
  other: {
    label: "Other",
    kind: "Identity provider",
    description: "Any identity provider that issues ID-JAG assertions.",
    placeholder: "https://login.example.com",
  },
};

export function providerKind(provider: McpTrustedIssuerProvider): string {
  return PROVIDERS[provider].kind;
}

/** Why an attempt was refused, in words an admin can act on. */
export function refusalText(reason: McpAutoConnectRefusalReason, organizationName: string): string {
  switch (reason) {
    case "malformed":
      return "The app sent an assertion Opengeni couldn't read.";
    case "wrong_type":
      return "The app sent a token that isn't an identity assertion.";
    case "issuer_disabled":
      return "Auto-connect was turned off.";
    case "signature_invalid":
      return "The signature didn't match the issuer's keys.";
    case "keys_unavailable":
      return "Opengeni couldn't load the issuer's signing keys.";
    case "wrong_audience":
      return "The assertion was meant for another server.";
    case "wrong_resource":
      return "The assertion was for another MCP server URL.";
    case "client_mismatch":
      return "The app's client ID didn't match the assertion.";
    case "client_not_allowed":
      return "That app isn't one of the apps allowed here.";
    case "unknown_client":
      return "Opengeni couldn't identify the app.";
    case "expired":
      return "The assertion had expired.";
    case "replayed":
      return "The same assertion was sent twice.";
    case "email_unverified":
      return "The issuer said the email isn't verified.";
    case "no_matching_member":
      return `No member of ${organizationName} has that verified email.`;
    case "several_organizations":
      return "Several organizations trust this issuer. Enter the Tenant ID in the issuer's setup.";
  }
}

export type TrustedIssuerState = "off" | "refused" | "waiting" | "working";

export function trustedIssuerState(issuer: McpTrustedIssuer): TrustedIssuerState {
  if (issuer.status === "disabled") return "off";
  if (issuer.lastRefusal) return "refused";
  return issuer.connectedPeople > 0 ? "working" : "waiting";
}

function peopleLabel(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A row's leading tile for an issuer, sized by the row. */
function trustedIssuerLeading(provider: McpTrustedIssuerProvider) {
  return (size: LogoTileSize) => <TrustedIssuerTile provider={provider} size={size} />;
}

export function TrustedIssuerTile({
  provider,
  size,
}: {
  provider: McpTrustedIssuerProvider;
  size?: LogoTileSize | undefined;
}) {
  if (provider === "claude") return <ProviderTile provider="claude_subscription" size={size} />;
  if (provider === "okta") return <LogoTile name="Okta" size={size} />;
  return <LogoTile icon={<KeyRoundIcon />} size={size} />;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((each) => b.includes(each));
}

function samePolicy(a: OrganizationAccessPolicy, b: OrganizationAccessPolicy): boolean {
  return (
    a.preset === b.preset &&
    sameStrings(a.permissions, b.permissions) &&
    a.workspaceScope.kind === b.workspaceScope.kind &&
    sameStrings(
      a.workspaceScope.kind === "selected" ? a.workspaceScope.workspaceIds : [],
      b.workspaceScope.kind === "selected" ? b.workspaceScope.workspaceIds : [],
    )
  );
}

/** Client IDs typed one per line (or separated by commas or spaces). */
export function parseClientIds(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/u)
        .map((each) => each.trim())
        .filter(Boolean),
    ),
  ];
}

function isIssuerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) &&
      !url.search &&
      !url.hash &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/* --------------------------- Connected agents list --------------------------- */

const ISSUER_COLUMNS: RowListColumn[] = [
  { id: "lastConnected", label: "Last connected", width: 132 },
];

/** The Auto-connect section on Connected agents, for owners and admins. */
export function AutoConnectSection({
  issuers,
  workspaces,
  onSetUp,
  onOpen,
}: {
  issuers: TrustedIssuers;
  workspaces: AccessWorkspace[] | null;
  onSetUp: () => void;
  onOpen: (id: string) => void;
}) {
  const list = issuers.list?.trustedIssuers ?? null;
  let body: ReactNode;
  if (issuers.error && list === null) {
    body = (
      <ErrorMessage
        variant="inline"
        title="Couldn't load auto-connect."
        announce
        action={<RowButton onClick={() => void issuers.refresh()}>Try again</RowButton>}
        {...apiErrorDetails(issuers.error)}
      >
        {userErrorTextWithoutReference(issuers.error)}
      </ErrorMessage>
    );
  } else if (list === null) {
    body = (
      <RowList label="Auto-connect" columns={ISSUER_COLUMNS} busy flush>
        <ListRowSkeleton count={1} />
      </RowList>
    );
  } else if (list.length === 0) {
    body = (
      <EmptyState
        variant="inline"
        title="Auto-connect is off."
        action={
          <Button type="button" onClick={onSetUp}>
            Set up auto-connect
          </Button>
        }
      />
    );
  } else {
    body = (
      <RowList label="Auto-connect" columns={ISSUER_COLUMNS} nameLabel="Issuer" flush>
        {list.map((issuer) => {
          const state = trustedIssuerState(issuer);
          return (
            <ListRow
              key={issuer.id}
              leading={trustedIssuerLeading(issuer.provider)}
              title={issuer.name}
              onOpen={() => onOpen(issuer.id)}
              indicator="open"
              status={
                state === "off" ? (
                  <StatusBadge variant="dot" status="off" />
                ) : state === "refused" ? (
                  <StatusBadge
                    variant="dot"
                    status="failed"
                    reason="The last attempt was refused. Open it to see why."
                  >
                    Refused
                  </StatusBadge>
                ) : state === "waiting" ? (
                  <StatusBadge variant="dot" status="queued">
                    Waiting
                  </StatusBadge>
                ) : undefined
              }
              description={[
                ...(issuer.connectedPeople > 0 ? [peopleLabel(issuer.connectedPeople)] : []),
                policySummary(issuer.access),
                scopeSummary(issuer.access.workspaceScope, workspaces),
              ].join(" · ")}
              cells={{
                lastConnected: issuer.lastConnectedAt ? (
                  <RelativeTime date={issuer.lastConnectedAt} />
                ) : (
                  <span className="text-fg-subtle">Never</span>
                ),
              }}
            />
          );
        })}
      </RowList>
    );
  }
  return (
    <Section
      title="Auto-connect"
      description="Connect everyone's agents from Claude or your identity provider, with no sign-in."
      action={
        list && list.length > 0 ? <RowButton onClick={onSetUp}>Add issuer</RowButton> : undefined
      }
    >
      {body}
    </Section>
  );
}

/* ------------------------------- Setup values ------------------------------- */

/** What the issuer's admin pastes on their side, for one provider. */
function SetupValueFields({
  provider,
  mcpUrl,
  audience,
  tenantId,
}: {
  provider: McpTrustedIssuerProvider;
  mcpUrl: string;
  audience: string;
  tenantId: string;
}) {
  const server = (
    <Field
      label="Server URL"
      hint={
        provider === "claude"
          ? "In Claude's organization settings, add Opengeni as a custom connector with this URL."
          : provider === "okta"
            ? "In Okta, set up Cross App Access for Opengeni with this URL as the resource."
            : "The MCP server people's agents connect to."
      }
    >
      <CopyField value={mcpUrl} label="server URL" variant="field" size="md" />
    </Field>
  );
  const tenant = (
    <Field
      label="Tenant ID"
      hint={
        provider === "claude"
          ? "Open the connector. Set up Managed authorization, choose Claude-issued, and enter this ID."
          : "Sent as aud_tenant, so Opengeni knows the assertion is for this organization."
      }
    >
      <CopyField value={tenantId} label="tenant ID" variant="field" size="md" />
    </Field>
  );
  const audienceField = (
    <Field
      label="Audience"
      hint="Opengeni's authorization server. Every assertion names it as its audience."
    >
      <CopyField value={audience} label="audience" variant="field" size="md" />
    </Field>
  );
  if (provider === "claude")
    return (
      <>
        {server}
        {tenant}
      </>
    );
  return (
    <>
      {server}
      {audienceField}
      {tenant}
    </>
  );
}

type IssuerCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; result: CheckMcpTrustedIssuerResponse };

/** Looks the typed issuer up after a short pause, the way sign-ins will. */
function useIssuerCheck(
  api: AutoConnectApi,
  issuer: string,
  jwksUri: string,
): {
  check: IssuerCheck;
  now: () => Promise<CheckMcpTrustedIssuerResponse | null>;
  retry: () => void;
} {
  const key = isIssuerUrl(issuer)
    ? JSON.stringify({ issuer, jwksUri: isIssuerUrl(jwksUri) ? jwksUri : null })
    : null;
  const [state, setState] = useState<{ key: string | null; check: IssuerCheck }>({
    key: null,
    check: { status: "idle" },
  });
  const run = useCallback(
    async (request: CheckMcpTrustedIssuerRequest): Promise<CheckMcpTrustedIssuerResponse> => {
      try {
        return await api.check(request);
      } catch (caught) {
        return {
          status: "failed",
          issuer: request.issuer,
          message: userErrorText(caught, "Couldn't check this issuer. Try again."),
        };
      }
    },
    [api],
  );
  useEffect(() => {
    if (!key) return;
    let live = true;
    const timer = setTimeout(() => {
      setState({ key, check: { status: "checking" } });
      void run(JSON.parse(key) as CheckMcpTrustedIssuerRequest).then((result) => {
        if (live) setState({ key, check: { status: "done", result } });
      });
    }, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, run]);
  const check: IssuerCheck = !key
    ? { status: "idle" }
    : state.key === key
      ? state.check
      : { status: "checking" };
  // A failed check may have been the issuer's hiccup: submitting asks again.
  const now = useCallback(async () => {
    if (!key) return null;
    if (state.key === key && state.check.status === "done" && state.check.result.status === "ok")
      return state.check.result;
    setState({ key, check: { status: "checking" } });
    const result = await run(JSON.parse(key) as CheckMcpTrustedIssuerRequest);
    setState({ key, check: { status: "done", result } });
    return result;
  }, [key, run, state]);
  const retry = useCallback(() => {
    void now();
  }, [now]);
  return { check, now, retry };
}

function keysFoundText(result: Extract<CheckMcpTrustedIssuerResponse, { status: "ok" }>): string {
  return `Found ${result.keyCount} signing ${result.keyCount === 1 ? "key" : "keys"}.`;
}

/** Only these apps, and where the keys are: rarely needed, so folded away. */
function AdvancedFields({
  provider,
  clientIds,
  onClientIdsChange,
  jwksUri,
  onJwksUriChange,
  errors,
  disabled = false,
}: {
  provider: McpTrustedIssuerProvider;
  clientIds: string;
  onClientIdsChange: (next: string) => void;
  jwksUri: string;
  onJwksUriChange: (next: string) => void;
  errors: { clientIds?: string | undefined; jwksUri?: string | undefined };
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(errors.clientIds || errors.jwksUri));
  useEffect(() => {
    if (errors.clientIds || errors.jwksUri) setOpen(true);
  }, [errors.clientIds, errors.jwksUri]);
  const apps = parseClientIds(clientIds);
  return (
    <FormDisclosure
      title="Advanced"
      summary={[
        apps.length === 0
          ? `Any app ${PROVIDERS[provider].label === "Other" ? "the issuer" : PROVIDERS[provider].label} vouches for`
          : `${apps.length} ${apps.length === 1 ? "app" : "apps"}`,
        jwksUri.trim() ? "Keys from a set URL" : "Keys found automatically",
      ].join(" · ")}
      open={open}
      onOpenChange={setOpen}
    >
      <Field
        label="Only these apps"
        optional
        hint="Client IDs, one per line. Leave it empty to allow any app the issuer vouches for."
        error={errors.clientIds}
      >
        <TextArea
          value={clientIds}
          onChange={(event) => onClientIdsChange(event.target.value)}
          rows={3}
          mono
          disabled={disabled}
          spellCheck={false}
        />
      </Field>
      <Field
        label="Key set URL"
        optional
        hint="Leave it empty to find the keys from the issuer URL."
        error={errors.jwksUri}
      >
        <TextInput
          value={jwksUri}
          onChange={(event) => onJwksUriChange(event.target.value)}
          placeholder="https://login.example.com/keys"
          inputMode="url"
          mono
          suppressAutofill
          disabled={disabled}
        />
      </Field>
    </FormDisclosure>
  );
}

/* -------------------------------- Set up page -------------------------------- */

export function AutoConnectSetupPage({
  api,
  organizationId,
  organizationName,
  setup,
  workspaces,
  workspacesError,
  onRetryWorkspaces,
  onClose,
  onCreated,
}: {
  api: AutoConnectApi;
  organizationId: string;
  organizationName: string;
  /** The URLs to paste on the issuer's side; null while loading. */
  setup: Pick<ListMcpTrustedIssuersResponse, "mcpUrl" | "audience"> | null;
  workspaces: AccessWorkspace[] | null;
  workspacesError?: boolean | undefined;
  onRetryWorkspaces?: (() => void) | undefined;
  onClose: () => void;
  onCreated: (issuer: McpTrustedIssuer) => void;
}) {
  const [provider, setProvider] = useState<McpTrustedIssuerProvider>("claude");
  const [issuer, setIssuer] = useState("");
  const [policy, setPolicy] = useState<OrganizationAccessPolicy>(defaultPolicy);
  const [clientIds, setClientIds] = useState("");
  const [jwksUri, setJwksUri] = useState("");
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [formError, setFormError] = useState<ReactNode>(null);
  const trimmedIssuer = issuer.trim();
  const { check, now, retry } = useIssuerCheck(api, trimmedIssuer, jwksUri.trim());
  const blocked = policyBlockedReason(policy);
  const clear = (key: string) =>
    setErrors((current) => {
      const { [key]: _removed, ...rest } = current;
      return rest;
    });
  const copy = PROVIDERS[provider];
  const issuerHint =
    check.status === "checking" ? (
      "Checking the issuer…"
    ) : check.status === "done" && check.result.status === "ok" ? (
      <span className="inline-flex items-center gap-1.5">
        <CircleCheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-status-idle" />
        {keysFoundText(check.result)}
      </span>
    ) : provider === "claude" ? (
      "Paste the Issuer URL Claude shows under Managed authorization."
    ) : provider === "okta" ? (
      "Your Okta authorization server's issuer, exactly as Okta shows it."
    ) : (
      "The issuer URL your identity provider signs assertions with, exactly as it publishes it."
    );
  const issuerError =
    errors.issuer ??
    (check.status === "done" && check.result.status === "failed" ? (
      <>
        {check.result.message}{" "}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-0 text-xs font-medium underline underline-offset-4"
          onClick={retry}
        >
          Check again
        </Button>
      </>
    ) : undefined);

  return (
    <FlushFormPage
      backLabel="Connected apps"
      onClose={onClose}
      title="Set up auto-connect"
      description={`People in ${organizationName} are connected the first time their agent uses Opengeni, with no sign-in.`}
      submitLabel="Turn on auto-connect"
      pendingLabel="Turning on…"
      error={formError}
      loading={setup === null}
      onSubmit={async (event) => {
        event.preventDefault();
        setFormError(null);
        const next: Partial<Record<string, string>> = {};
        if (!trimmedIssuer)
          next.issuer = `Paste the issuer URL from ${copy.label === "Other" ? "your identity provider" : copy.label}.`;
        else if (!isIssuerUrl(trimmedIssuer))
          next.issuer = "Use the issuer's https:// URL, without a query or fragment.";
        if (jwksUri.trim() && !isIssuerUrl(jwksUri.trim()))
          next.jwksUri = "Use an https:// URL, or leave it empty.";
        const apps = parseClientIds(clientIds);
        if (apps.length > 20) next.clientIds = "Allow at most 20 apps.";
        if (apps.some((each) => each.length > 256)) next.clientIds = "A client ID is too long.";
        if (blocked) next.access = blocked;
        setErrors(next);
        if (Object.keys(next).length > 0) return false;
        // The check's own message (with Check again) says why it can't be trusted.
        if ((await now())?.status === "failed") return false;
        try {
          const created = await api.create({
            name:
              provider === "other" ? hostOf(trimmedIssuer).slice(0, 80) : PROVIDERS[provider].label,
            provider,
            issuer: trimmedIssuer,
            ...(jwksUri.trim() ? { jwksUri: jwksUri.trim() } : {}),
            ...(apps.length > 0 ? { allowedClientIds: apps } : {}),
            access: policy as CreateMcpTrustedIssuerRequest["access"],
          });
          onCreated(created);
          return true;
        } catch (caught) {
          setFormError(userErrorText(caught));
          return false;
        }
      }}
    >
      <FieldStack>
        <ChoiceCards
          label="Connect from"
          value={provider}
          onValueChange={(value) => {
            setProvider(value as McpTrustedIssuerProvider);
            clear("issuer");
          }}
        >
          {(["claude", "okta", "other"] as const).map((each) => (
            <ChoiceCard
              key={each}
              value={each}
              title={PROVIDERS[each].label}
              description={PROVIDERS[each].description}
            />
          ))}
        </ChoiceCards>
        {setup ? (
          <SetupValueFields
            provider={provider}
            mcpUrl={setup.mcpUrl}
            audience={setup.audience}
            tenantId={organizationId}
          />
        ) : null}
        <Field label="Issuer URL" hint={issuerHint} error={issuerError}>
          <TextInput
            value={issuer}
            onChange={(event) => {
              setIssuer(event.target.value);
              clear("issuer");
            }}
            placeholder={copy.placeholder}
            inputMode="url"
            mono
            suppressAutofill
            spellCheck={false}
          />
        </Field>
        <OrganizationAccessFields
          organizationName={organizationName}
          policy={policy}
          onPolicyChange={(next) => {
            setPolicy(next);
            clear("access");
          }}
          workspaces={workspaces}
          workspacesError={workspacesError ?? false}
          {...(onRetryWorkspaces ? { onRetryWorkspaces } : {})}
          includesPersonal
          forEachPerson
          {...(errors.access
            ? {
                errors:
                  policy.workspaceScope.kind === "selected" &&
                  policy.workspaceScope.workspaceIds.length === 0
                    ? { workspaces: errors.access }
                    : { permissions: errors.access },
              }
            : {})}
        />
        <AdvancedFields
          provider={provider}
          clientIds={clientIds}
          onClientIdsChange={(next) => {
            setClientIds(next);
            clear("clientIds");
          }}
          jwksUri={jwksUri}
          onJwksUriChange={(next) => {
            setJwksUri(next);
            clear("jwksUri");
          }}
          errors={{ clientIds: errors.clientIds, jwksUri: errors.jwksUri }}
        />
      </FieldStack>
    </FlushFormPage>
  );
}

/* -------------------------------- Issuer page -------------------------------- */

const EVENT_COLUMNS: RowListColumn[] = [{ id: "at", label: "When", width: 116 }];

function useIssuerEvents(api: AutoConnectApi, id: string, version: string | undefined) {
  const [state, setState] = useState<{
    events: McpTrustedIssuerEvent[] | null;
    error: Error | null;
  }>({ events: null, error: null });
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const { events } = await api.events(id);
      if (sequence.current === current) setState({ events, error: null });
    } catch (caught) {
      if (sequence.current === current)
        setState((previous) => ({
          ...previous,
          error: caught instanceof Error ? caught : new Error(String(caught)),
        }));
    }
  }, [api, id]);
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current += 1;
    };
    // A changed issuer (turned off, new access) can add attempts.
  }, [refresh, version]);
  return { ...state, refresh };
}

function IssuerStatusNotice({
  issuer,
  organizationName,
}: {
  issuer: McpTrustedIssuer;
  organizationName: string;
}) {
  const state = trustedIssuerState(issuer);
  if (state === "off")
    return (
      <Notice title="Off">
        Agents it connected are disconnected. People can still connect by signing in.
      </Notice>
    );
  if (state === "refused")
    return (
      <Notice tone="failed" title="The last attempt was refused">
        {refusalText(issuer.lastRefusal!.reason, organizationName)}{" "}
        <RelativeTime date={issuer.lastRefusal!.at} />
      </Notice>
    );
  if (state === "waiting")
    return (
      <Notice tone="waiting" title="Waiting for the first connection">
        {issuer.provider === "claude"
          ? "Run the connection test in Claude's Managed authorization setup, or use Opengeni from Claude."
          : "It turns active once someone's agent connects through it."}
      </Notice>
    );
  // Working: the people count and last connection beside it say so.
  return null;
}

export function TrustedIssuerPage({
  api,
  issuer,
  loading,
  organizationId,
  organizationName,
  setup,
  workspaces,
  workspacesError,
  onRetryWorkspaces,
  onClose,
  onRefresh,
  onSaved,
  onRemoved,
}: {
  api: AutoConnectApi;
  issuer: McpTrustedIssuer | null;
  loading: boolean;
  organizationId: string;
  organizationName: string;
  setup: Pick<ListMcpTrustedIssuersResponse, "mcpUrl" | "audience"> | null;
  workspaces: AccessWorkspace[] | null;
  workspacesError?: boolean | undefined;
  onRetryWorkspaces?: (() => void) | undefined;
  onClose: () => void;
  /** Loads the issuer's summary again: people connected, last connected, status. */
  onRefresh: () => void;
  onSaved: (next: McpTrustedIssuer) => void;
  onRemoved: (id: string) => void;
}) {
  const back = { label: "Connected apps", onClick: onClose };
  if (!issuer)
    return (
      <DetailPage back={back} className={FLUSH_DETAIL_PAGE_CLASS}>
        {loading ? (
          <RowList label="Trusted issuer" busy flush>
            <ListRowSkeleton count={1} />
          </RowList>
        ) : (
          <EmptyState
            variant="page"
            icon={<KeyRoundIcon />}
            title="This issuer isn't here"
            description="It may have been removed."
          />
        )}
      </DetailPage>
    );
  return (
    <LoadedTrustedIssuerPage
      key={issuer.id}
      api={api}
      issuer={issuer}
      organizationId={organizationId}
      organizationName={organizationName}
      setup={setup}
      workspaces={workspaces}
      workspacesError={workspacesError}
      onRetryWorkspaces={onRetryWorkspaces}
      onClose={onClose}
      onRefresh={onRefresh}
      onSaved={onSaved}
      onRemoved={onRemoved}
    />
  );
}

function LoadedTrustedIssuerPage({
  api,
  issuer,
  organizationId,
  organizationName,
  setup,
  workspaces,
  workspacesError,
  onRetryWorkspaces,
  onClose,
  onRefresh,
  onSaved,
  onRemoved,
}: {
  api: AutoConnectApi;
  issuer: McpTrustedIssuer;
  organizationId: string;
  organizationName: string;
  setup: Pick<ListMcpTrustedIssuersResponse, "mcpUrl" | "audience"> | null;
  workspaces: AccessWorkspace[] | null;
  workspacesError?: boolean | undefined;
  onRetryWorkspaces?: (() => void) | undefined;
  onClose: () => void;
  onRefresh: () => void;
  onSaved: (next: McpTrustedIssuer) => void;
  onRemoved: (id: string) => void;
}) {
  const initialClientIds = (issuer.allowedClientIds ?? []).join("\n");
  const [policy, setPolicy] = useState<OrganizationAccessPolicy>(issuer.access);
  const [clientIds, setClientIds] = useState(initialClientIds);
  const [jwksUri, setJwksUri] = useState(issuer.jwksUri ?? "");
  const [errors, setErrors] = useState<{ clientIds?: string; jwksUri?: string }>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [statusPending, setStatusPending] = useState(false);
  const [removing, setRemoving] = useState(false);
  const events = useIssuerEvents(api, issuer.id, issuer.updatedAt);
  // A saved change resets the form; a refresh of the same settings keeps edits.
  const applied = useRef(issuer.updatedAt);
  useEffect(() => {
    if (applied.current === issuer.updatedAt) return;
    applied.current = issuer.updatedAt;
    setPolicy(issuer.access);
    setClientIds((issuer.allowedClientIds ?? []).join("\n"));
    setJwksUri(issuer.jwksUri ?? "");
  }, [issuer]);
  const apps = parseClientIds(clientIds);
  const changed = useMemo(
    () =>
      !samePolicy(policy, issuer.access) ||
      !sameStrings(apps, issuer.allowedClientIds ?? []) ||
      jwksUri.trim() !== (issuer.jwksUri ?? ""),
    [policy, apps, jwksUri, issuer],
  );
  const blocked = policyBlockedReason(policy);
  const on = issuer.status === "active";
  const reset = () => {
    setPolicy(issuer.access);
    setClientIds(initialClientIds);
    setJwksUri(issuer.jwksUri ?? "");
    setErrors({});
    setSaveError(null);
  };
  const setStatus = async (status: "active" | "disabled") => {
    setStatusPending(true);
    try {
      const next = await api.update(issuer.id, { status });
      onSaved(next);
      toast.success(status === "active" ? "Auto-connect turned on" : "Auto-connect turned off");
    } catch (caught) {
      toast.error("Couldn't change it", { description: userErrorText(caught) });
    } finally {
      setStatusPending(false);
    }
  };
  const save = async () => {
    const next: typeof errors = {};
    if (jwksUri.trim() && !isIssuerUrl(jwksUri.trim()))
      next.jwksUri = "Use an https:// URL, or leave it empty.";
    if (apps.length > 20) next.clientIds = "Allow at most 20 apps.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await api.update(issuer.id, {
        access: policy as CreateMcpTrustedIssuerRequest["access"],
        allowedClientIds: apps.length > 0 ? apps : null,
        jwksUri: jwksUri.trim() || null,
      });
      onSaved(saved);
      toast.success(`${issuer.name} updated`);
    } catch (caught) {
      setSaveError(`The change wasn't saved. ${userErrorText(caught, "Try again.")}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DetailPage
      back={{ label: "Connected apps", onClick: onClose }}
      className={FLUSH_DETAIL_PAGE_CLASS}
    >
      <DetailPageHeader
        leading={<TrustedIssuerTile provider={issuer.provider} />}
        title={issuer.name}
        chips={on ? undefined : <StatusBadge status="off" variant="outline" />}
        meta={[providerKind(issuer.provider), hostOf(issuer.issuer)]}
        actions={
          <MoreMenu label={`More for ${issuer.name}`}>
            <DropdownMenuItem
              disabled={statusPending}
              onSelect={() => void setStatus(on ? "disabled" : "active")}
            >
              {on ? <PowerOffIcon /> : <PowerIcon />}
              {on ? "Turn off" : "Turn on"}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(true)}>
              <TrashIcon />
              Remove
            </DropdownMenuItem>
          </MoreMenu>
        }
      />
      <DetailPageBody
        aside={
          <DetailAside>
            <DetailAsideItem label="People connected">{issuer.connectedPeople}</DetailAsideItem>
            <DetailAsideItem label="Last connected">
              {issuer.lastConnectedAt ? <RelativeTime date={issuer.lastConnectedAt} /> : "Never"}
            </DetailAsideItem>
            <DetailAsideItem label="Added">
              <RelativeTime date={issuer.createdAt} format="date" />
            </DetailAsideItem>
          </DetailAside>
        }
      >
        {trustedIssuerState(issuer) === "working" ? null : (
          <DetailSection>
            <IssuerStatusNotice issuer={issuer} organizationName={organizationName} />
          </DetailSection>
        )}
        <DetailSection
          title="What agents can do"
          description="Never more than each person can do. Changes apply to every agent it connected."
        >
          <div className="flex min-w-0 flex-col gap-6">
            <OrganizationAccessFields
              organizationName={organizationName}
              policy={policy}
              onPolicyChange={(next) => {
                setPolicy(next);
                setSaveError(null);
              }}
              workspaces={workspaces}
              workspacesError={workspacesError ?? false}
              {...(onRetryWorkspaces ? { onRetryWorkspaces } : {})}
              includesPersonal
              forEachPerson
              disabled={saving}
            />
            <AdvancedFields
              provider={issuer.provider}
              clientIds={clientIds}
              onClientIdsChange={(next) => {
                setClientIds(next);
                setErrors((current) => ({ ...current, clientIds: undefined }));
              }}
              jwksUri={jwksUri}
              onJwksUriChange={(next) => {
                setJwksUri(next);
                setErrors((current) => ({ ...current, jwksUri: undefined }));
              }}
              errors={errors}
              disabled={saving}
            />
            {saveError ? (
              <p role="alert" className="m-0 text-sm leading-5 text-danger">
                {saveError}
              </p>
            ) : null}
            {changed ? (
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                {blocked ? (
                  <span className="mr-auto text-sm leading-5 text-fg-muted">{blocked}</span>
                ) : null}
                <Button type="button" variant="ghost" disabled={saving} onClick={reset}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={saving || blocked !== null}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
              </div>
            ) : null}
          </div>
        </DetailSection>
        <DetailSection
          title="Setup"
          description={
            issuer.provider === "claude"
              ? "What Claude's Managed authorization setup needs."
              : "What the identity provider needs."
          }
        >
          <FieldStack>
            <Field label="Issuer URL">
              <CopyField value={issuer.issuer} label="issuer URL" variant="field" size="md" />
            </Field>
            {setup ? (
              <SetupValueFields
                provider={issuer.provider}
                mcpUrl={setup.mcpUrl}
                audience={setup.audience}
                tenantId={organizationId}
              />
            ) : null}
          </FieldStack>
        </DetailSection>
        <DetailSection
          title="Recent attempts"
          description="Each new connection and each refusal, newest first."
          action={
            <RowButton
              onClick={() => {
                void events.refresh();
                onRefresh();
              }}
            >
              Refresh
            </RowButton>
          }
        >
          <IssuerEvents
            events={events.events}
            error={events.error}
            organizationName={organizationName}
            onRetry={() => void events.refresh()}
          />
        </DetailSection>
      </DetailPageBody>
      <DestructiveConfirm
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${issuer.name}?`}
        consequences={[
          "Every agent it connected is disconnected at once.",
          "People can still connect their agents by signing in.",
        ]}
        confirmLabel="Remove"
        pendingLabel="Removing…"
        onConfirm={async () => {
          try {
            await api.remove(issuer.id);
          } catch (caught) {
            throw new Error(userErrorText(caught), { cause: caught });
          }
          toast.success(`${issuer.name} removed`);
          onRemoved(issuer.id);
        }}
      />
    </DetailPage>
  );
}

export function IssuerEvents({
  events,
  error,
  organizationName,
  onRetry,
}: {
  events: McpTrustedIssuerEvent[] | null;
  error: Error | null;
  organizationName: string;
  onRetry: () => void;
}) {
  if (error && events === null)
    return (
      <ErrorMessage
        variant="inline"
        title="Couldn't load recent attempts."
        announce
        action={<RowButton onClick={onRetry}>Try again</RowButton>}
      >
        {userErrorTextWithoutReference(error)}
      </ErrorMessage>
    );
  if (events === null)
    return (
      <RowList label="Recent attempts" columns={EVENT_COLUMNS} busy flush>
        <ListRowSkeleton count={2} />
      </RowList>
    );
  if (events.length === 0)
    return (
      <EmptyState
        variant="inline"
        title="No attempts yet."
        description="Each agent's first connection shows here, and anything refused."
      />
    );
  return (
    <RowList label="Recent attempts" columns={EVENT_COLUMNS} nameLabel="Person" flush>
      {events.map((event) => (
        <ListRow
          key={event.id}
          title={event.person?.name ?? event.email ?? "Unknown person"}
          status={
            event.outcome === "connected" ? (
              <StatusBadge variant="dot" status="connected" />
            ) : (
              <StatusBadge variant="dot" status="failed">
                Refused
              </StatusBadge>
            )
          }
          description={[
            event.clientName ?? "An agent",
            event.outcome === "connected"
              ? event.person && event.email
                ? event.email
                : null
              : event.reason
                ? refusalText(event.reason, organizationName)
                : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          cells={{ at: <RelativeTime date={event.at} /> }}
        />
      ))}
    </RowList>
  );
}
