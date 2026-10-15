import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type {
  SiteAbuseReport,
  SiteHostnameAvailability,
  SitePublication,
  SitePublishWarning,
  SitePublishWarningFix,
  WorkspaceArtifact,
} from "@opengeni/sdk";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  FlagIcon,
  GlobeIcon,
  LoaderCircleIcon,
  PlusIcon,
  RotateCcwIcon,
  UsersIcon,
  XIcon,
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
import { Disclosure } from "@/components/ui/disclosure";
import { CheckboxField, Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import { FormDialog, FormPage } from "@/components/ui/form-dialog";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile, type LogoTileSize } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { Section } from "@/components/ui/section";
import { SelectMenu } from "@/components/ui/select-menu";
import { SettingRow } from "@/components/ui/setting-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { userErrorText } from "@/lib/api-error";
import {
  ACCESS_CHOICES,
  SPEND_PERIOD_OPTIONS,
  abuseCategoryLabel,
  availabilityMessage,
  domainFromHostname,
  draftFromPublication,
  hasOutsideViewers,
  invitedEmailProblem,
  labelProblemMessage,
  normalizeLabelInput,
  outsideLimitsFromDraft,
  outsideUsageLine,
  platformRefusal,
  publicationRequest,
  readinessTitle,
  sentence,
  siteErrorCode,
  sitePublicationLoadFromError,
  suggestedLabel,
  suspendedByLabel,
  viewAsVisitorUrl,
  type SitePublicationLoad,
  type SitePublishDraft,
  type SitesClientConfig,
  type SpendPeriod,
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
  | "applySitePublicationFix"
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
  /** The viewer administers the workspace. Only admins change limits and restore an admin's takedown. */
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
  const [limitError, setLimitError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ title: string; body: string } | null>(null);
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
  const outsideViewers = hasOutsideViewers(draft.access);
  const publicDisabled = sites.publicEnabled === false;
  // Readiness warnings describe the saved access; hide them while it changes.
  const warnings =
    saved?.status === "active" && saved.access === draft.access ? saved.warnings : [];

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
    if (outsideViewers && isAdmin && "invalid" in outsideLimitsFromDraft(draft)) {
      setLimitError("Use dollar amounts like 10 or 0.50.");
      return false;
    }
    setLimitError(null);
    setRefusal(null);
    try {
      const next = await client.updateSitePublication(workspaceId, site.id, request);
      onPublication(next);
      toast.success(publishing ? "Site published" : "Changes saved", {
        ...(publishing ? { description: next.hostname } : {}),
      });
      return true;
    } catch (error) {
      const code = siteErrorCode(error);
      if (code === "site_hostname_taken") {
        setLabelError("Another Site uses this name.");
        return false;
      }
      if (code === "site_admin_required") {
        if (request.limitProfile) setLimitError("Only a workspace admin can change limits.");
        else setAgentError("Only a workspace admin can make this change.");
        return false;
      }
      const platform = platformRefusal(error);
      if (platform) {
        setRefusal(platform);
        return false;
      }
      throw error;
    }
  };

  const applyFix = async (fix: SitePublishWarningFix) => {
    try {
      onPublication(await client.applySitePublicationFix(workspaceId, site.id, fix));
      toast.success("Fixed");
    } catch (error) {
      toast.error("Couldn't apply the fix", { description: userErrorText(error) });
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
          {refusal ? (
            <Notice tone="failed" title={refusal.title}>
              {refusal.body}
            </Notice>
          ) : null}
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

          {warnings.length > 0 ? (
            <SiteReadiness warnings={warnings} access={draft.access} onFix={applyFix} />
          ) : null}

          <div className="flex min-w-0 flex-col gap-4">
            <CheckboxField
              label="Let people chat with the Site's agent"
              checked={draft.agentEnabled}
              onCheckedChange={(agentEnabled) => update({ agentEnabled })}
            />
            {draft.agentEnabled ? (
              <div className="flex min-w-0 flex-col gap-4 pl-7">
                <SiteAgentModelField
                  workspaceId={workspaceId}
                  model={draft.agentModel}
                  allowed={saved?.effectiveLimits.agentModels ?? null}
                  onChange={(agentModel) => update({ agentModel })}
                />
                {outsideViewers ? (
                  <OutsideAgentSection
                    workspaceId={workspaceId}
                    draft={draft}
                    saved={saved}
                    isAdmin={isAdmin}
                    error={limitError ?? agentError}
                    onChange={(patch) => {
                      setLimitError(null);
                      update(patch);
                    }}
                  />
                ) : agentError ? (
                  <p className="text-sm text-danger">{agentError}</p>
                ) : null}
              </div>
            ) : null}
          </div>

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
  const viewAs = viewAsVisitorUrl(publication);
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
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <a
          href={publication.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-full items-center gap-1 font-medium og-link"
        >
          <span className="truncate">{publication.hostname}</span>
          <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0" />
        </a>
        {viewAs ? (
          <a href={viewAs} target="_blank" rel="noreferrer" className="text-fg-muted og-link">
            View as visitor
          </a>
        ) : null}
      </span>
    </Notice>
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

/**
 * Invited and public Sites: the agent for people outside the workspace, the
 * one Site limit, the optional limit per person and this period's usage.
 * Members are never limited here. Only admins change it.
 */
function OutsideAgentSection({
  workspaceId,
  draft,
  saved,
  isAdmin,
  error,
  onChange,
}: {
  workspaceId: string;
  draft: SitePublishDraft;
  saved: SitePublication | null;
  isAdmin: boolean;
  error: string | null;
  onChange: (patch: Partial<SitePublishDraft>) => void;
}) {
  const locked = !isAdmin;
  // The usage line and the model line describe what is saved.
  const savedHere = saved?.status === "active" && saved.access === draft.access ? saved : null;
  return (
    <SettingRow
      variant="control-right"
      label="Agent for people outside the workspace"
      description="People outside the workspace can only use this Site's own data."
      hint={locked ? "Only workspace admins change this." : undefined}
      error={error}
      control={
        <Switch
          checked={draft.outsideAgent}
          disabled={locked}
          disabledReason="Only workspace admins change this."
          onCheckedChange={(outsideAgent) => onChange({ outsideAgent })}
        />
      }
      className="border-0 px-0"
    >
      {draft.outsideAgent ? (
        <div className="flex min-w-0 flex-col gap-3 pt-1">
          {savedHere?.outsideAgentModel && savedHere.agent.model === draft.agentModel ? (
            <OutsideModelLine workspaceId={workspaceId} model={savedHere.outsideAgentModel} />
          ) : null}
          <SpendLimitLine
            label="Limit"
            amount={draft.siteLimit}
            period={draft.sitePeriod}
            disabled={locked}
            onAmountChange={(siteLimit) => onChange({ siteLimit })}
            onPeriodChange={(sitePeriod) => onChange({ sitePeriod })}
          />
          {draft.personLimitOn ? (
            <SpendLimitLine
              label="Per person"
              amount={draft.personLimit}
              period={draft.personPeriod}
              disabled={locked}
              onAmountChange={(personLimit) => onChange({ personLimit })}
              onPeriodChange={(personPeriod) => onChange({ personPeriod })}
              onRemove={() => onChange({ personLimitOn: false, personLimit: "" })}
            />
          ) : locked ? null : (
            <button
              type="button"
              onClick={() =>
                onChange({ personLimitOn: true, personLimit: "1", personPeriod: "day" })
              }
              className="inline-flex items-center gap-1 self-start text-sm font-medium og-link"
            >
              <PlusIcon aria-hidden="true" className="size-3.5" />
              Limit per person
            </button>
          )}
          {savedHere ? (
            <p className="text-xs text-fg-muted">{outsideUsageLine(savedHere)}</p>
          ) : null}
        </div>
      ) : null}
    </SettingRow>
  );
}

/** "Limit: [$10] per [month ▾]". */
function SpendLimitLine({
  label,
  amount,
  period,
  disabled,
  onAmountChange,
  onPeriodChange,
  onRemove,
}: {
  label: string;
  amount: string;
  period: SpendPeriod;
  disabled: boolean;
  onAmountChange: (amount: string) => void;
  onPeriodChange: (period: SpendPeriod) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      <span className="w-20 shrink-0 text-fg-muted max-sm:w-auto">{label}</span>
      <div className="relative w-24 shrink-0">
        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-muted">
          $
        </span>
        <TextInput
          aria-label={`${label} amount`}
          inputMode="decimal"
          placeholder="None"
          value={amount}
          disabled={disabled}
          onChange={(event) => onAmountChange(event.target.value)}
          className="pl-6"
        />
      </div>
      <span className="text-fg-muted">per</span>
      <SelectMenu
        aria-label={`${label} period`}
        options={SPEND_PERIOD_OPTIONS}
        value={period}
        disabled={disabled}
        onValueChange={onPeriodChange}
        className="w-28"
      />
      {onRemove && !disabled ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove the ${label.toLowerCase()} limit`}
          onClick={onRemove}
        >
          <XIcon aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

/** A subscription model is never used by people outside the workspace: name the one they get. */
function OutsideModelLine({ workspaceId, model }: { workspaceId: string; model: string }) {
  const catalog = useWorkspaceModelCatalog(workspaceId);
  const label = catalog.rows.find((row) => row.id === model)?.label ?? model;
  return (
    <p className="text-xs text-fg-muted">
      People outside the workspace use {label} (paid with credits).
    </p>
  );
}

/** "2 things won't work for public visitors", opening to the list with one-click fixes. */
function SiteReadiness({
  warnings,
  access,
  onFix,
}: {
  warnings: readonly SitePublishWarning[];
  access: SitePublication["access"];
  onFix: (fix: SitePublishWarningFix) => Promise<void>;
}) {
  const [fixing, setFixing] = useState<number | null>(null);
  return (
    <Disclosure title={readinessTitle(warnings, access)}>
      <ul className="flex min-w-0 flex-col gap-3 pt-1">
        {warnings.map((warning, index) => (
          <li
            key={`${warning.code}:${warning.message}`}
            className="flex min-w-0 items-start justify-between gap-3"
          >
            <div className="min-w-0">
              <p className="text-sm text-fg">{warning.message}</p>
              <p className="text-xs leading-[18px] text-fg-muted">{warning.suggestion}</p>
            </div>
            {warning.fix ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={fixing !== null}
                onClick={() => {
                  setFixing(index);
                  void onFix(warning.fix!).finally(() => setFixing(null));
                }}
                className="shrink-0 rounded-[10px] pointer-coarse:h-11"
              >
                {fixing === index ? "Fixing…" : "Fix"}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

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
