import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type {
  SiteAbuseReport,
  SiteHostnameAvailability,
  SitePublication,
  WorkspaceArtifact,
} from "@opengeni/sdk";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FlagIcon,
  GlobeIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { ModelPicker } from "@/components/pickers";
import { payerShortLabel } from "@/components/models/models-ui";
import { Button, buttonVariants } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { useCopyToClipboard } from "@/components/ui/copy-field";
import { showUndoToast } from "@/components/ui/destructive-confirm";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmailChipsInput } from "@/components/ui/email-chips-input";
import { CheckboxField, Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import { FormDialog, FormPage } from "@/components/ui/form-dialog";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile, type LogoTileSize } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { Section } from "@/components/ui/section";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { UsageMeter } from "@/components/ui/usage-meter";
import { apiErrorFacts, userErrorText } from "@/lib/api-error";
import {
  ACCESS_CHOICES,
  CUSTOM_LIMIT_FIELDS,
  LIMIT_PROFILE_OPTIONS,
  abuseCategoryLabel,
  availabilityMessage,
  customOverrides,
  domainFromHostname,
  draftFromPublication,
  formatUsdMicros,
  invitedEmailProblem,
  knownLimits,
  labelProblemMessage,
  limitProfileDescription,
  limitSummary,
  normalizeLabelInput,
  publicationRequest,
  sentence,
  sitePublicationLoadFromError,
  suggestedLabel,
  suspendedByLabel,
  type SitePublicationLoad,
  type SitePublishDraft,
  type SitesClientConfig,
} from "@/lib/site-publishing";
import { useWorkspaceModelCatalog } from "@/lib/use-workspace-model-catalog";
import { cn } from "@/lib/utils";

export type SitePublishingClient = Pick<
  OpenGeniBrowserClient,
  | "getSitePublication"
  | "updateSitePublication"
  | "unpublishSite"
  | "checkSiteHostname"
  | "takeDownSite"
  | "restoreSite"
  | "listSiteAbuseReports"
  | "updateSiteAbuseReport"
>;

/**
 * The Site's publication as its page needs it. Only people who manage the
 * Site ask; everyone else sees no publishing UI. A deployment without a
 * Sites domain answers 503, which hides the entry point.
 */
export function useSitePublication({
  client,
  workspaceId,
  siteId,
  enabled,
}: {
  client: Pick<SitePublishingClient, "getSitePublication">;
  workspaceId: string;
  siteId: string;
  enabled: boolean;
}) {
  const [load, setLoad] = useState<SitePublicationLoad>({ state: "loading" });
  const abortRef = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    abortRef.current?.abort();
    if (!enabled) return;
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const publication = await client.getSitePublication(workspaceId, siteId, {
        signal: abort.signal,
      });
      if (!abort.signal.aborted) setLoad({ state: "ready", publication });
    } catch (error) {
      if (!abort.signal.aborted) setLoad(sitePublicationLoadFromError(error));
    }
  }, [client, enabled, siteId, workspaceId]);
  useEffect(() => {
    setLoad({ state: "loading" });
    void reload();
    return () => abortRef.current?.abort();
  }, [reload]);
  const setPublication = useCallback(
    (publication: SitePublication) => setLoad({ state: "ready", publication }),
    [],
  );
  return { load, reload, setPublication };
}

function livePublication(load: SitePublicationLoad): SitePublication | null {
  return load.state === "ready" && load.publication.status === "active" ? load.publication : null;
}

/** The header's Publish button; hidden where the deployment can't publish. */
export function SitePublishButton({
  load,
  onOpen,
}: {
  load: SitePublicationLoad;
  onOpen: () => void;
}) {
  if (load.state === "unavailable" || load.state === "forbidden") return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onOpen}
      // Beside Edit and ⋯ on a phone, only the icon fits; the name stays.
      title="Publish"
      className="rounded-[10px] pointer-coarse:h-11 max-sm:px-2.5 pointer-coarse:max-sm:w-11"
    >
      <GlobeIcon aria-hidden="true" />
      <span className="max-sm:sr-only">Publish</span>
    </Button>
  );
}

/** The live address in the Site header's meta line, or the takedown badge. */
export function sitePublicationHeader(load: SitePublicationLoad): {
  meta: ReactNode;
  chip: ReactNode;
} {
  const live = livePublication(load);
  const suspended = load.state === "ready" && load.publication.status === "suspended";
  return {
    meta: live ? (
      <a
        key="publication"
        href={live.url}
        target="_blank"
        rel="noreferrer"
        className="relative z-10 font-medium og-link text-fg-muted"
      >
        {live.hostname}
      </a>
    ) : null,
    chip: suspended ? (
      <StatusBadge tone="danger" icon="auto">
        Taken down
      </StatusBadge>
    ) : null,
  };
}

type Availability =
  | { state: "idle" }
  | { state: "checking"; label: string }
  | { state: "done"; label: string; result: SiteHostnameAvailability }
  | { state: "failed"; label: string };

/** Ask the API whether a label is free, 350ms after typing stops. */
function useHostnameAvailability(
  client: Pick<SitePublishingClient, "checkSiteHostname">,
  workspaceId: string,
  label: string,
  skip: boolean,
): Availability {
  const [availability, setAvailability] = useState<Availability>({ state: "idle" });
  useEffect(() => {
    if (skip || labelProblemMessage(label)) {
      setAvailability({ state: "idle" });
      return;
    }
    setAvailability({ state: "checking", label });
    const abort = new AbortController();
    const timer = setTimeout(() => {
      client
        .checkSiteHostname(workspaceId, label, { signal: abort.signal })
        .then((result) => {
          if (!abort.signal.aborted) setAvailability({ state: "done", label, result });
        })
        .catch(() => {
          if (!abort.signal.aborted) setAvailability({ state: "failed", label });
        });
    }, 350);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [client, label, skip, workspaceId]);
  return availability;
}

export type SitePublishPageProps = {
  client: SitePublishingClient;
  workspaceId: string;
  workspaceName: string;
  site: Pick<WorkspaceArtifact, "id" | "title" | "visibility">;
  load: SitePublicationLoad;
  onPublication: (publication: SitePublication) => void;
  onReload: () => void;
  onBack: () => void;
  /** The viewer owns the Site or administers the workspace, and may publish. */
  canManage: boolean;
  /**
   * The viewer administers the workspace. Only admins change limits, give
   * guests the agent's tools, and restore an admin's takedown.
   */
  isAdmin: boolean;
  /** Offered while the Site is Only me and the viewer owns it. */
  onShareWithWorkspace?: (() => void) | undefined;
  sites: SitesClientConfig;
  /** Fixed suffix for the suggested label, for previews and tests. */
  labelSuffix?: string;
};

/**
 * Publish a Site to the web: its address, who can open it, its embedded
 * agent and limits, search engines, and reports and takedown. A page of its
 * own (`?view=publish`) with the Site page as its back link.
 */
export function SitePublishPage(props: SitePublishPageProps) {
  const { load, site, onBack } = props;
  const back = { label: site.title, onClick: onBack };
  const blocked = (title: string, body: ReactNode, action?: ReactNode) => (
    <FormPage back={back} title="Publish to web" submitLabel="Publish" footer={false}>
      <Notice title={title} action={action} actionLayout="responsive">
        {body}
      </Notice>
    </FormPage>
  );
  if (!props.canManage || load.state === "forbidden")
    return blocked(
      "You can't publish this Site",
      "Only its owner and workspace admins can publish it.",
    );
  if (load.state === "unavailable")
    return blocked(
      "Publishing isn't set up on this server",
      "An administrator sets a Sites domain to turn it on.",
    );
  if (site.visibility === "private" && load.state !== "ready")
    return blocked(
      "Share this Site with the workspace first",
      "A Site that only you can see can't be published.",
      props.onShareWithWorkspace ? (
        <Button type="button" size="sm" onClick={props.onShareWithWorkspace}>
          <UsersIcon aria-hidden="true" />
          Share with workspace
        </Button>
      ) : undefined,
    );
  if (load.state === "error")
    return blocked(
      "Couldn't load publishing",
      userErrorText(load.error),
      <Button type="button" size="sm" variant="outline" onClick={props.onReload}>
        <RotateCcwIcon aria-hidden="true" />
        Retry
      </Button>,
    );
  if (load.state === "loading")
    return (
      <FormPage
        back={back}
        title="Publish to web"
        submitLabel="Publish"
        loading
        loadingFields={4}
      />
    );
  return (
    <SitePublishForm
      key={load.state === "ready" ? load.publication.updatedAt : "new"}
      {...props}
      saved={load.state === "ready" ? load.publication : null}
    />
  );
}

function SitePublishForm({
  client,
  workspaceId,
  workspaceName,
  site,
  saved,
  onPublication,
  onBack,
  sites,
  labelSuffix,
  isAdmin,
}: SitePublishPageProps & { saved: SitePublication | null }) {
  const forceNoindex = sites.forceNoindex === true;
  const [draft, setDraft] = useState<SitePublishDraft>(() =>
    draftFromPublication(saved, suggestedLabel(site.title, labelSuffix), forceNoindex),
  );
  const [labelError, setLabelError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"unpublish" | "restore" | null>(null);
  const [takedownOpen, setTakedownOpen] = useState(false);
  const update = (patch: Partial<SitePublishDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const labelUnchanged = saved?.label === draft.label;
  // A taken-down Site keeps its address until it is restored.
  const suspended = saved?.status === "suspended";
  const availability = useHostnameAvailability(client, workspaceId, draft.label, labelUnchanged);
  const reportedDomain =
    sites.domain ??
    domainFromHostname(saved?.hostname, saved?.label ?? "") ??
    (availability.state === "done"
      ? domainFromHostname(availability.result.hostname, availability.label)
      : null);
  // Keep the suffix once known, so it doesn't vanish while a name is invalid.
  const [lastDomain, setLastDomain] = useState<string | null>(reportedDomain);
  if (reportedDomain && reportedDomain !== lastDomain) setLastDomain(reportedDomain);
  const domain = reportedDomain ?? lastDomain;
  const localProblem = labelProblemMessage(draft.label);
  const remoteProblem =
    availability.state === "done" && availability.label === draft.label
      ? availabilityMessage(availability.result)
      : null;
  const shownLabelError = labelError ?? localProblem ?? remoteProblem;

  const publishing = !saved || saved.status === "unpublished";
  const request = publicationRequest(draft, saved, {
    publish: publishing,
    canChangeLimits: isAdmin,
  });
  const dirty = Object.keys(request).length > 0;
  const limits = knownLimits(
    draft.profile,
    saved,
    (() => {
      const custom = customOverrides(draft);
      return "overrides" in custom ? custom.overrides : {};
    })(),
  );
  const publicDisabled = sites.publicEnabled === false;
  const agentsBlocked = draft.access === "public" && sites.publicAgentsEnabled === false;
  const agentTools = saved?.agent.tools ?? [];
  // Non-admins may turn guest tools off, never on.
  const guestToolsLocked = !isAdmin && !draft.guestTools && !saved?.agent.guestTools;

  const submit = async () => {
    setLabelError(null);
    setAgentError(null);
    if (localProblem || remoteProblem) return false;
    if (availability.state === "checking" && !labelUnchanged) return false;
    const badEmail =
      draft.access === "invited" ? draft.invitedEmails.find(invitedEmailProblem) : undefined;
    if (badEmail) {
      setEmailError(`${badEmail} isn't an email address.`);
      return false;
    }
    setEmailError(null);
    if (draft.profile === "custom") {
      const custom = customOverrides(draft);
      if ("invalid" in custom) {
        setCustomError("Use whole numbers, and dollar amounts like 0.05.");
        return false;
      }
    }
    setCustomError(null);
    try {
      const next = await client.updateSitePublication(workspaceId, site.id, request);
      onPublication(next);
      toast.success(publishing ? "Site published" : "Changes saved", {
        ...(publishing ? { description: next.hostname } : {}),
      });
      return true;
    } catch (error) {
      const { code } = apiErrorFacts(error);
      if (code === "site_hostname_taken") {
        setLabelError("Another Site uses this name.");
        return false;
      }
      if (code === "site_admin_required") {
        if (request.limitProfile) setCustomError("Only a workspace admin can change limits.");
        else if (request.access === "public")
          setAgentError(
            draft.guestTools
              ? "Only a workspace admin can open a Site with tools to everyone."
              : "Only a workspace admin can give the agent's tools to invited people.",
          );
        else if (request.access === "invited" || request.invitedEmails)
          setEmailError("Only a workspace admin can invite people while the agent has tools.");
        else setAgentError("Only a workspace admin can give the agent's tools to guests.");
        return false;
      }
      throw error;
    }
  };

  const unpublish = async () => {
    if (!saved) return;
    setBusy("unpublish");
    try {
      const next = await client.unpublishSite(workspaceId, site.id);
      onPublication(next);
      showUndoToast({
        title: "Site unpublished",
        description: `${saved.hostname} stays reserved for this workspace.`,
        onUndo: () =>
          void client
            .updateSitePublication(workspaceId, site.id, { status: "active" })
            .then(onPublication)
            .catch((error) =>
              toast.error("Couldn't publish again", { description: userErrorText(error) }),
            ),
      });
    } catch (error) {
      toast.error("Couldn't unpublish", { description: userErrorText(error) });
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy("restore");
    try {
      onPublication(await client.restoreSite(workspaceId, site.id));
      toast.success("Site restored");
    } catch (error) {
      toast.error("Couldn't restore the Site", { description: userErrorText(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <FormPage
        back={{ label: site.title, onClick: onBack }}
        title="Publish to web"
        description={`Give “${site.title}” its own address on the web.`}
        submitLabel={publishing ? "Publish" : "Save changes"}
        pendingLabel={publishing ? "Publishing…" : "Saving…"}
        onSubmit={submit}
        onCancel={onBack}
        footer={publishing || dirty ? undefined : false}
      >
        <FieldStack>
          {saved ? (
            <PublicationStatus
              publication={saved}
              isAdmin={isAdmin}
              busy={busy}
              onUnpublish={() => void unpublish()}
              onRestore={() => void restore()}
            />
          ) : null}
          <Field
            label="Address"
            error={shownLabelError}
            hint={
              suspended ? (
                "Restore the Site to change its address."
              ) : (
                <AvailabilityHint
                  availability={availability}
                  label={draft.label}
                  domain={domain}
                  unchanged={labelUnchanged}
                />
              )
            }
          >
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <TextInput
                value={draft.label}
                disabled={suspended}
                onChange={(event) => {
                  setLabelError(null);
                  update({ label: normalizeLabelInput(event.target.value) });
                }}
                suppressAutofill
                spellCheck={false}
                autoCapitalize="off"
                maxLength={63}
                className="w-auto min-w-0 flex-1 basis-56 font-mono text-[13px]"
              />
              {domain ? (
                <span className="min-w-0 truncate font-mono text-xs text-fg-muted">.{domain}</span>
              ) : null}
            </div>
          </Field>

          <Field label="Who can open it" group>
            <ChoiceCards
              value={draft.access}
              onValueChange={(value) => update({ access: value as SitePublishDraft["access"] })}
              variant="radio"
            >
              {ACCESS_CHOICES.map((choice) => (
                <ChoiceCard
                  key={choice.value}
                  value={choice.value}
                  title={choice.title}
                  description={choice.description({
                    workspaceName,
                    loginOnly: sites.loginOnly === true,
                  })}
                  disabled={choice.value === "public" && publicDisabled}
                  disabledReason="Public Sites are turned off on this server."
                />
              ))}
            </ChoiceCards>
          </Field>

          {draft.access === "invited" ? (
            <Field
              label="Invited people"
              hint="They open the Site after signing in with this email."
              error={emailError}
            >
              <EmailChipsInput
                chips={draft.invitedEmails.map((value) => ({
                  value,
                  ...(invitedEmailProblem(value) ? { problem: invitedEmailProblem(value) } : {}),
                }))}
                onChange={(invitedEmails) => {
                  setEmailError(null);
                  update({ invitedEmails });
                }}
                placeholder="name@example.com"
              />
            </Field>
          ) : null}

          <div className="flex min-w-0 flex-col gap-4">
            <CheckboxField
              label="Let visitors chat with the Site's agent"
              description="Your organization pays for these conversations."
              checked={draft.agentEnabled && !agentsBlocked}
              disabled={agentsBlocked}
              disabledReason="Agents on public Sites are turned off on this server."
              onCheckedChange={(agentEnabled) => update({ agentEnabled })}
            />
            {draft.agentEnabled && !agentsBlocked ? (
              <div className="flex min-w-0 flex-col gap-4 pl-7">
                <SiteAgentModelField
                  workspaceId={workspaceId}
                  model={draft.agentModel}
                  allowed={limits?.agentModels ?? null}
                  onChange={(agentModel) => update({ agentModel })}
                />
                {agentTools.length > 0 ? (
                  <Field label="Tools" group error={agentError}>
                    <div className="flex min-w-0 flex-col gap-3">
                      <p className="text-sm text-fg-muted">
                        Uses {agentTools.length} workspace{" "}
                        {agentTools.length === 1 ? "connection" : "connections"}.
                      </p>
                      {draft.access === "public" ? (
                        <CheckboxField
                          label="Let everyone use these tools"
                          description="Visitors who aren't members or invited get them too."
                          checked={draft.guestTools}
                          disabled={guestToolsLocked}
                          disabledReason="Only workspace admins can turn this on."
                          onCheckedChange={(guestTools) => {
                            setAgentError(null);
                            update({ guestTools });
                          }}
                        />
                      ) : null}
                    </div>
                  </Field>
                ) : null}
              </div>
            ) : null}
          </div>

          <Field
            label="Limits"
            group
            hint={
              isAdmin
                ? limitProfileDescription(draft.profile)
                : "Only workspace admins change limits."
            }
            error={customError}
          >
            <div className="flex min-w-0 flex-col gap-4">
              <SegmentedControl
                options={LIMIT_PROFILE_OPTIONS}
                value={draft.profile}
                disabled={!isAdmin}
                onValueChange={(profile) => {
                  setCustomError(null);
                  update({ profile });
                }}
                className="self-start max-sm:self-stretch"
                fullWidth={false}
              />
              {draft.profile === "custom" && isAdmin ? (
                <CustomLimitFields
                  values={draft.custom}
                  onChange={(custom) => {
                    setCustomError(null);
                    update({ custom });
                  }}
                />
              ) : limits ? (
                <LimitFacts limits={limits} />
              ) : null}
              {saved && saved.effectiveLimits.agentMicrosPerSitePerMonth ? (
                <UsageMeter
                  label="Agent spend this month"
                  measure="used"
                  percent={
                    (saved.usage.agentMicrosThisMonth /
                      saved.effectiveLimits.agentMicrosPerSitePerMonth) *
                    100
                  }
                  valueLabel={`${formatUsdMicros(saved.usage.agentMicrosThisMonth)} of ${formatUsdMicros(saved.effectiveLimits.agentMicrosPerSitePerMonth)}`}
                />
              ) : null}
            </div>
          </Field>

          <CheckboxField
            label="Hide from search engines"
            description="Asks search engines not to list the Site."
            checked={draft.noindex}
            disabled={forceNoindex}
            disabledReason="Always on for this server."
            onCheckedChange={(noindex) => update({ noindex })}
          />

          {saved ? (
            <SiteReports
              client={client}
              workspaceId={workspaceId}
              siteId={site.id}
              publication={saved}
              onTakeDown={() => setTakedownOpen(true)}
            />
          ) : null}
        </FieldStack>
      </FormPage>
      {saved ? (
        <TakedownDialog
          open={takedownOpen}
          onOpenChange={setTakedownOpen}
          hostname={saved.hostname}
          onTakeDown={async (reason) => {
            const next = await client.takeDownSite(workspaceId, site.id, { reason });
            onPublication(next);
            toast.success("Site taken down", {
              description: "Visitors see a takedown notice.",
            });
          }}
        />
      ) : null}
    </>
  );
}

function AvailabilityHint({
  availability,
  label,
  domain,
  unchanged,
}: {
  availability: Availability;
  label: string;
  domain: string | null;
  unchanged: boolean;
}) {
  if (unchanged) return "Changing it moves the Site. The old address stops working.";
  if (
    availability.state === "checking" ||
    (availability.state !== "idle" && availability.label !== label)
  )
    return (
      <span className="inline-flex items-center gap-1.5">
        <LoaderCircleIcon aria-hidden="true" className="size-3.5 motion-safe:animate-spin" />
        Checking…
      </span>
    );
  if (availability.state === "failed")
    return "Couldn't check this name. It's checked again when you publish.";
  if (availability.state === "done" && availability.result.available)
    return (
      <span className="inline-flex items-center gap-1.5 text-status-idle">
        <CheckIcon aria-hidden="true" className="size-3.5" />
        {domain ? `${label}.${domain}` : label} is available
      </span>
    );
  return "Lowercase letters, digits and hyphens.";
}

function PublicationStatus({
  publication,
  isAdmin,
  busy,
  onUnpublish,
  onRestore,
}: {
  publication: SitePublication;
  isAdmin: boolean;
  busy: "unpublish" | "restore" | null;
  onUnpublish: () => void;
  onRestore: () => void;
}) {
  const { state: copied, copy } = useCopyToClipboard();
  if (publication.status === "suspended") {
    const { suspendedAt, suspendedBy, suspendedReason } = publication.moderation;
    const byPlatform = suspendedBy === "platform";
    // Only Opengeni restores its own takedowns, and only admins restore an admin's.
    const adminOnly = suspendedBy === "admin" && !isAdmin;
    return (
      <Notice
        tone="failed"
        title="Taken down"
        actionLayout="responsive"
        action={
          byPlatform || adminOnly ? undefined : (
            <Button type="button" size="sm" disabled={busy !== null} onClick={onRestore}>
              <RotateCcwIcon aria-hidden="true" />
              {busy === "restore" ? "Restoring…" : "Restore"}
            </Button>
          )
        }
      >
        By {suspendedByLabel(suspendedBy)}
        {suspendedAt ? (
          <>
            {" "}
            <RelativeTime date={suspendedAt} inSentence />
          </>
        ) : null}
        . {suspendedReason ? `${sentence(suspendedReason)} ` : null}Visitors to{" "}
        {publication.hostname} see a takedown notice.
        {byPlatform ? " Contact support to restore it." : null}
        {adminOnly ? " A workspace admin can restore it." : null}
      </Notice>
    );
  }
  if (publication.status === "unpublished")
    return (
      <Notice title="Not published">
        {publication.hostname} stays reserved for this workspace. Publish to put it back online.
      </Notice>
    );
  return (
    <Notice
      icon={<GlobeIcon className="size-4" />}
      title="Published"
      actionLayout="responsive"
      action={
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void copy(publication.url)}
            className="rounded-[10px] pointer-coarse:h-11"
          >
            {copied === "copied" ? (
              <CheckIcon aria-hidden="true" />
            ) : (
              <CopyIcon aria-hidden="true" />
            )}
            {copied === "copied" ? "Copied" : "Copy link"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={onUnpublish}
            className="rounded-[10px] pointer-coarse:h-11"
          >
            {busy === "unpublish" ? "Unpublishing…" : "Unpublish"}
          </Button>
        </div>
      }
    >
      <a
        href={publication.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex max-w-full items-center gap-1 font-medium og-link"
      >
        <span className="truncate">{publication.hostname}</span>
        <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0" />
      </a>
    </Notice>
  );
}

function LimitFacts({ limits }: { limits: NonNullable<ReturnType<typeof knownLimits>> }) {
  return (
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm max-sm:grid-cols-1 max-sm:gap-y-0.5">
      {limitSummary(limits).map((fact) => (
        <div key={fact.label} className="contents max-sm:block max-sm:pb-1.5">
          <dt className="text-fg-muted">{fact.label}</dt>
          <dd className="min-w-0 text-fg">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function CustomLimitFields({
  values,
  onChange,
}: {
  values: SitePublishDraft["custom"];
  onChange: (values: SitePublishDraft["custom"]) => void;
}) {
  return (
    <div className="grid min-w-0 grid-cols-2 gap-4 max-sm:grid-cols-1">
      {CUSTOM_LIMIT_FIELDS.map((field) => (
        <Field key={field.key} label={field.label}>
          <div className="relative min-w-0">
            {field.money ? (
              <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-fg-muted">
                $
              </span>
            ) : null}
            <TextInput
              inputMode="decimal"
              placeholder="No limit"
              value={values[field.key]}
              onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
              className={cn(field.money && "pl-6")}
            />
          </div>
        </Field>
      ))}
    </div>
  );
}

/** The embedded agent's model, with its payment source, from the workspace catalog. */
function SiteAgentModelField({
  workspaceId,
  model,
  allowed,
  onChange,
}: {
  workspaceId: string;
  model: string | null;
  allowed: string[] | null;
  onChange: (model: string | null) => void;
}) {
  const catalog = useWorkspaceModelCatalog(workspaceId);
  const rows = useMemo(
    () => (allowed ? catalog.rows.filter((row) => allowed.includes(row.id)) : catalog.rows),
    [allowed, catalog.rows],
  );
  const fallback = catalog.defaultSelection?.model ?? rows[0]?.id ?? "";
  const shown = model ?? fallback;
  const selected = rows.find((row) => row.id === shown);
  return (
    <Field label="Model" hint={model === null ? "Uses the workspace default." : undefined}>
      <ModelPicker
        rows={rows}
        model={shown}
        effort={catalog.defaultSelection?.reasoningEffort ?? "medium"}
        latencyMode="standard"
        allowLatencyMode={false}
        allowModelOptions={false}
        loading={catalog.loading}
        error={catalog.error}
        messages={{ label: "Agent model" }}
        triggerStyle="field"
        triggerMeta={selected ? payerShortLabel(selected) : null}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "max-w-full min-w-[180px] justify-start gap-2 self-start rounded-[10px] px-2.5 pointer-coarse:h-11",
        )}
        onModelChange={(next) => onChange(next)}
        onEffortChange={() => {}}
        onLatencyModeChange={() => {}}
      />
    </Field>
  );
}

const reportRowLeading = (size: LogoTileSize) => (
  <LogoTile size={size} icon={<FlagIcon />} name="Report" />
);

function SiteReports({
  client,
  workspaceId,
  siteId,
  publication,
  onTakeDown,
}: {
  client: Pick<SitePublishingClient, "listSiteAbuseReports" | "updateSiteAbuseReport">;
  workspaceId: string;
  siteId: string;
  publication: SitePublication;
  onTakeDown: () => void;
}) {
  const [reports, setReports] = useState<SiteAbuseReport[] | null>(null);
  const [failed, setFailed] = useState(false);
  const openReports = publication.moderation.openReports;
  useEffect(() => {
    const abort = new AbortController();
    setFailed(false);
    client
      .listSiteAbuseReports(workspaceId, siteId, { signal: abort.signal })
      .then((response) => {
        if (!abort.signal.aborted) setReports(response.reports.filter((r) => r.status === "open"));
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => abort.abort();
  }, [client, openReports, siteId, workspaceId]);
  const close = async (report: SiteAbuseReport, status: "dismissed" | "actioned") => {
    try {
      await client.updateSiteAbuseReport(workspaceId, siteId, report.id, { status });
      setReports((current) => current?.filter((item) => item.id !== report.id) ?? null);
      toast.success(status === "dismissed" ? "Report dismissed" : "Report marked as handled");
    } catch (error) {
      toast.error("Couldn't update the report", { description: userErrorText(error) });
    }
  };
  return (
    <Section
      title="Reports"
      description="Visitors can report this Site from the link at the bottom of every page."
      action={
        publication.status === "suspended" ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onTakeDown}
            className="rounded-[10px] text-danger hover:text-danger pointer-coarse:h-11"
          >
            Take down…
          </Button>
        )
      }
      className="border-t border-border pt-6"
    >
      <div className="mt-3">
        {failed ? (
          <p className="text-sm text-fg-muted">Couldn't load reports.</p>
        ) : reports === null ? (
          <p className="text-sm text-fg-muted">Loading reports…</p>
        ) : reports.length === 0 ? (
          <p className="text-sm text-fg-muted">No open reports.</p>
        ) : (
          <RowList label="Open reports" flush>
            {reports.map((report) => (
              <ListRow
                key={report.id}
                leading={reportRowLeading}
                title={abuseCategoryLabel(report.category)}
                description={report.message || undefined}
                meta={[
                  report.contactEmail ?? "Anonymous",
                  <RelativeTime key="created" date={report.createdAt} />,
                ]}
                menuLabel={`Actions for the ${abuseCategoryLabel(report.category)} report`}
                menu={
                  <>
                    <DropdownMenuItem onSelect={() => void close(report, "actioned")}>
                      <CheckIcon />
                      Mark as handled
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void close(report, "dismissed")}>
                      Dismiss
                    </DropdownMenuItem>
                  </>
                }
              />
            ))}
          </RowList>
        )}
      </div>
    </Section>
  );
}

function TakedownDialog({
  open,
  onOpenChange,
  hostname,
  onTakeDown,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostname: string;
  onTakeDown: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setReason("");
      setError(null);
    }
  }, [open]);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Take this Site down?"
      description={`${hostname} shows a takedown notice right away. You can restore it later.`}
      submitLabel="Take down"
      pendingLabel="Taking down…"
      tone="destructive"
      onSubmit={async () => {
        if (!reason.trim()) {
          setError("Say why, for the record.");
          return false;
        }
        await onTakeDown(reason.trim());
      }}
    >
      <Field label="Reason" error={error}>
        <TextArea
          value={reason}
          maxLength={2000}
          onChange={(event) => {
            setError(null);
            setReason(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}
