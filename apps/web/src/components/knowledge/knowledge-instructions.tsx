import {
  OpenGeniApiError,
  WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS,
  type WorkspaceInstructionPolicyHead,
  type WorkspaceInstructionPolicyListResponse,
} from "@opengeni/sdk";
import { useNavigate } from "@tanstack/react-router";
import { resolveWorkspaceDefaultAgentIdentity } from "@opengeni/contracts";
import {
  ArrowUpRightIcon,
  BotIcon,
  Building2Icon,
  HistoryIcon,
  PencilIcon,
  ScrollTextIcon,
  SparklesIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DetailPage, DetailPageBody, DetailPageHeader } from "@/components/ui/detail-page";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DetailSection } from "@/components/ui/detail-sheet";
import { showUndoToast } from "@/components/ui/destructive-confirm";
import { Field, TextArea } from "@/components/ui/field";
import { FormDialog, FormPage } from "@/components/ui/form-dialog";
import { InAppHelpLink } from "@/components/in-app-help-link";
import { HelpLink, InlineHelp } from "@/components/ui/inline-help";
import { ListRow, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { MoreMenu, RowButton } from "@/components/ui/page-actions";
import { RelativeTime } from "@/components/ui/relative-time";
import { RevisionHistory, type Revision } from "@/components/ui/revision-history";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppContext } from "@/context";
import { canManageWorkspaceSettings } from "@/lib/permissions";
import { createWorkspaceInstructionSave } from "@/lib/workspace-instruction-save";
import { activeGlobalWorkspaceInstructionHead } from "@/lib/workspace-instructions";
import { promptCopy, useAgentBrainPromptCatalog } from "@/routes/agent-brain-prompt";
import { resolveAgentBrainPromptModel } from "@/lib/agent-brain-prompt-model";
import {
  useCompanyProfileInventory,
  useWorkspaceStateInventory,
} from "@/routes/workspace-state-loader";

import { errorText } from "./knowledge-data";
import { Markdown } from "./knowledge-markdown";

/* ----------------------------------------------------------------------------
   Instructions: what is always in every agent's prompt. The tab lists the
   workspace instructions and the organization identity as rows; each opens
   its own page where the text reads as it is, with Edit, Ask Opengeni and
   History. Edit and History are their own pages too.
   -------------------------------------------------------------------------- */

export { Markdown } from "./knowledge-markdown";

/* ------------------------------------------------------------------ data */

type SaveRun = ReturnType<typeof createWorkspaceInstructionSave>;

export interface WorkspaceInstructions {
  loading: boolean;
  error: string | null;
  reload: () => void;
  content: string;
  configured: boolean;
  head: Pick<
    WorkspaceInstructionPolicyHead,
    "revisionId" | "activationVersion" | "activatedAt"
  > | null;
  /** Saves the complete text. Keeps one logical save across an uncertain outcome. */
  save: (content: string) => Promise<void>;
  /** A rollback activated a new head. */
  accept: (head: WorkspaceInstructionPolicyHead) => void;
}

/** The active global workspace instruction, shared by the tab and the Edit page. */
export function useWorkspaceInstructions(workspaceId: string): WorkspaceInstructions {
  const { client } = useAppContext();
  const inventory = useWorkspaceStateInventory(client, workspaceId);
  const [confirmed, setConfirmed] = useState<{
    head: WorkspaceInstructionPolicyHead;
    content: string;
  } | null>(null);
  const projected = inventory.state ? activeGlobalWorkspaceInstructionHead(inventory.state) : null;
  const head =
    confirmed && confirmed.head.activationVersion >= (projected?.activationVersion ?? 0)
      ? confirmed.head
      : projected;
  const legacy = inventory.state?.policy.legacyRuntime.workspaceOverrideConfigured ?? false;
  const [content, setContent] = useState("");
  const [loadingContent, setLoadingContent] = useState(true);
  const [contentError, setContentError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const pending = useRef<SaveRun | null>(null);
  const revisionId = head?.revisionId ?? null;

  useEffect(() => {
    if (!inventory.state) return;
    let cancelled = false;
    // A save already returned the durable head and its text; no second read.
    if (confirmed?.head.revisionId === revisionId) {
      setContent(confirmed.content);
      setLoadingContent(false);
      return;
    }
    setLoadingContent(true);
    setContentError(null);
    void (async () => {
      try {
        const next = revisionId
          ? (await client.getWorkspaceInstructionPolicyRevision(workspaceId, revisionId)).content
          : legacy
            ? ((await client.getWorkspace(workspaceId)).agentInstructions ?? "")
            : "";
        if (!cancelled) setContent(next);
      } catch (reason) {
        if (!cancelled) setContentError(errorText(reason));
      } finally {
        if (!cancelled) setLoadingContent(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, revisionId, legacy, confirmed, inventory.state, retry]);

  const save = useCallback(
    async (text: string) => {
      if (!pending.current?.matches(client, workspaceId, text, head)) {
        pending.current = createWorkspaceInstructionSave(client, workspaceId, text, head);
      }
      try {
        const saved = await pending.current.run();
        pending.current = null;
        setConfirmed(saved);
        inventory.acceptInstructionHead(saved.head);
      } catch (reason) {
        const uncertain = reason instanceof OpenGeniApiError && reason.outcomeUnknown;
        if (!uncertain) pending.current = null;
        throw new Error(
          uncertain
            ? "Couldn't confirm whether the instructions were saved. Your text is still here. Save again to retry."
            : errorText(reason),
          { cause: reason },
        );
      }
    },
    [client, workspaceId, head, inventory],
  );

  const accept = useCallback(
    (next: WorkspaceInstructionPolicyHead) => {
      setConfirmed(null);
      inventory.acceptInstructionHead(next);
      void inventory.reload();
    },
    [inventory],
  );

  return {
    loading: (inventory.loading && !inventory.state) || loadingContent,
    error: inventory.error && !inventory.state ? errorText(inventory.error) : contentError,
    reload: () => {
      void inventory.reload();
      setRetry((value) => value + 1);
    },
    content,
    configured: revisionId !== null || legacy,
    head,
    save,
    accept,
  };
}

/* ------------------------------------------------------------------- tab */

/** The first line of a text as a one-line preview, without markdown markers. */
function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((each) => each.trim())
    .find(Boolean);
  return (line ?? "").replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "");
}

const INSTRUCTION_COLUMNS: RowListColumn[] = [
  { id: "updated", label: "Changed", width: 112, align: "end", hideLabel: true },
];

export interface InstructionsTabProps {
  workspaceId: string;
  workspaceName: string;
  personal: boolean;
  instructions: WorkspaceInstructions;
  onOpenInstructions: () => void;
  onOpenIdentity: () => void;
  onGoToLibrary: () => void;
}

/**
 * What is always in every agent's prompt, as rows like every other list: the
 * workspace instructions and the organization identity. Each opens its page.
 */
export function InstructionsTab({
  workspaceId,
  workspaceName,
  personal,
  instructions,
  onOpenInstructions,
  onOpenIdentity,
  onGoToLibrary,
}: InstructionsTabProps) {
  const { client, clientConfig } = useAppContext();
  const agentSettings = clientConfig.agentConfig?.enabled === true;
  const identity = useCompanyProfileInventory(client, workspaceId);
  const profile = identity.response?.activeRevision?.profile ?? null;
  const { loading, error, content, configured, head } = instructions;
  const identityText = profile ? firstLine(profile.identity || profile.mission || "") : "";

  return (
    <div className="flex min-w-0 flex-col gap-4 pt-6">
      <RowList label="Always applied to every agent" columns={INSTRUCTION_COLUMNS} flush>
        {agentSettings ? <AgentIdentityRow workspaceId={workspaceId} /> : null}
        <ListRow
          leading={<LogoTile icon={<ScrollTextIcon />} />}
          title={personal ? "Instructions for your Personal workspace" : "Workspace instructions"}
          meta={[
            loading
              ? "Loading…"
              : error && !content
                ? "Couldn't load them"
                : content.trim()
                  ? firstLine(content)
                  : configured
                    ? "Set in earlier settings"
                    : "Not written yet",
          ]}
          cells={head ? { updated: <RelativeTime date={head.activatedAt} /> } : {}}
          indicator="open"
          onOpen={onOpenInstructions}
        />
        <ListRow
          leading={<LogoTile icon={<Building2Icon />} />}
          title="Organization identity"
          meta={[
            identity.loading && !identity.response
              ? "Loading…"
              : identity.error && !identity.response
                ? "Couldn't load it"
                : identityText || "Not described yet",
          ]}
          indicator="open"
          onOpen={onOpenIdentity}
        />
      </RowList>
      {agentSettings ? (
        <InlineHelp>
          Every prompt in {workspaceName} starts with who the agent is, then your organization, then
          these instructions, then anything set for one chat. Instructions take priority over
          OpenGeni's default way of working, but never over its safety rules or how it runs tools.
        </InlineHelp>
      ) : null}
      <InlineHelp>
        {agentSettings ? "These are" : "Both are"} added to every chat and schedule in{" "}
        {workspaceName}, before anything agents look up. Facts go in the{" "}
        <HelpLink onClick={onGoToLibrary}>Library</HelpLink>, and step-by-step procedures in Skills,
        in{" "}
        <InAppHelpLink href={`/workspaces/${workspaceId}/plugins?section=skills`}>
          Capabilities
        </InAppHelpLink>
        .
      </InlineHelp>
    </div>
  );
}

/* ------------------------------------------------------ instructions page */

export function InstructionsPage({
  workspaceId,
  workspaceName,
  personal,
  canEdit,
  instructions,
  onBack,
  onEdit,
  onOpenHistory,
}: {
  workspaceId: string;
  workspaceName: string;
  personal: boolean;
  canEdit: boolean;
  instructions: WorkspaceInstructions;
  onBack: () => void;
  onEdit: () => void;
  onOpenHistory: () => void;
}) {
  const [askOpen, setAskOpen] = useState(false);
  const { loading, error, content, configured, head } = instructions;
  const unreadable = Boolean(error && !content);
  return (
    <DetailPage back={{ label: "Instructions", onClick: onBack }}>
      <DetailPageHeader
        leading={<LogoTile icon={<ScrollTextIcon />} />}
        title={personal ? "Instructions for your Personal workspace" : "Workspace instructions"}
        meta={[
          `Added to every chat and schedule in ${workspaceName}`,
          loading ? null : head ? (
            <span key="changed">
              changed <RelativeTime date={head.activatedAt} inSentence />
            </span>
          ) : configured ? (
            "set in earlier settings"
          ) : null,
          !canEdit
            ? personal
              ? "Editing isn't available yet"
              : "Only workspace admins can change these"
            : null,
        ]}
        actions={
          canEdit ? (
            <>
              <RowButton onClick={() => setAskOpen(true)} disabled={loading}>
                <SparklesIcon aria-hidden="true" />
                Ask Opengeni
              </RowButton>
              <Button
                type="button"
                size="sm"
                onClick={onEdit}
                disabled={loading || unreadable}
                className="rounded-[10px] pointer-coarse:h-11"
              >
                <PencilIcon aria-hidden="true" />
                {configured ? "Edit" : "Write instructions"}
              </Button>
              {head ? (
                <MoreMenu label="More actions for the instructions">
                  <DropdownMenuItem onSelect={onOpenHistory}>
                    <HistoryIcon />
                    History
                  </DropdownMenuItem>
                </MoreMenu>
              ) : null}
            </>
          ) : head ? (
            <RowButton onClick={onOpenHistory}>
              <HistoryIcon aria-hidden="true" />
              History
            </RowButton>
          ) : null
        }
      />
      <DetailPageBody>
        <DetailSection>
          {loading ? (
            <div
              role="status"
              aria-label="Loading the instructions"
              className="flex flex-col gap-2"
            >
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3.5 w-3/5" />
              <Skeleton className="h-3.5 w-2/5" />
            </div>
          ) : unreadable ? (
            <Notice
              tone="failed"
              title="Couldn't load the instructions"
              action={
                <Button type="button" size="sm" variant="outline" onClick={instructions.reload}>
                  Try again
                </Button>
              }
              actionLayout="responsive"
            >
              {error}
            </Notice>
          ) : content.trim() ? (
            <Markdown text={content} />
          ) : (
            <p className="text-sm leading-6 text-fg-muted">
              {canEdit
                ? "No instructions yet. Write how agents should work here, like review rules or the tone for pull requests."
                : personal
                  ? "No personal instructions yet."
                  : "No workspace instructions yet. A workspace admin can add them."}
            </p>
          )}
        </DetailSection>
      </DetailPageBody>
      {canEdit ? (
        <AskOpenGeniDialog
          open={askOpen}
          onOpenChange={setAskOpen}
          workspaceId={workspaceId}
          personal={personal}
        />
      ) : null}
    </DetailPage>
  );
}

/* ---------------------------------------------------------- identity page */

export function IdentityPage({
  workspaceId,
  canManageOrganization,
  onBack,
}: {
  workspaceId: string;
  canManageOrganization: boolean;
  onBack: () => void;
}) {
  const { client } = useAppContext();
  const navigate = useNavigate();
  const identity = useCompanyProfileInventory(client, workspaceId);
  const profile = identity.response?.activeRevision?.profile ?? null;
  const settings = `/workspaces/${workspaceId}/organization?section=knowledge`;
  return (
    <DetailPage back={{ label: "Instructions", onClick: onBack }}>
      <DetailPageHeader
        leading={<LogoTile icon={<Building2Icon />} />}
        title="Organization identity"
        meta={[
          "Who your organization is and why it exists",
          canManageOrganization ? null : "Managed by your organization's owners",
        ]}
        actions={
          canManageOrganization ? (
            <RowButton onClick={() => void navigate({ href: settings })}>
              Edit in organization settings
              <ArrowUpRightIcon aria-hidden="true" />
            </RowButton>
          ) : null
        }
      />
      <DetailPageBody>
        {identity.loading && !identity.response ? (
          <DetailSection>
            <Skeleton className="h-10 w-full" />
          </DetailSection>
        ) : identity.error && !identity.response ? (
          <DetailSection>
            <Notice
              tone="failed"
              title="Couldn't load the organization identity"
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void identity.reload()}
                >
                  Try again
                </Button>
              }
              actionLayout="responsive"
            />
          </DetailSection>
        ) : profile && (profile.identity || profile.mission) ? (
          <>
            {profile.identity ? (
              <DetailSection title="Identity">
                <p className="text-sm leading-6 text-fg">{profile.identity}</p>
              </DetailSection>
            ) : null}
            {profile.mission ? (
              <DetailSection title="Mission">
                <p className="text-sm leading-6 text-fg">{profile.mission}</p>
              </DetailSection>
            ) : null}
          </>
        ) : (
          <DetailSection>
            <p className="text-sm leading-6 text-fg-muted">
              {canManageOrganization
                ? "Say who your organization is in organization settings, and every agent starts with it."
                : "Your organization's owners haven't described it yet."}
            </p>
          </DetailSection>
        )}
      </DetailPageBody>
    </DetailPage>
  );
}

/**
 * "Who the agent is": the workspace's default agent identity for new chats.
 * It is edited with the rest of the agent defaults, in workspace settings, so
 * the row opens that page for the admins who can change it.
 */
function AgentIdentityRow({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const canManage = canManageWorkspaceSettings(
    context.accessContext,
    workspace,
    context.managedSelfContext,
  );
  const resolved = resolveWorkspaceDefaultAgentIdentity(
    workspace?.settings,
    workspace?.agentInstructions,
  );
  return (
    <ListRow
      leading={<LogoTile icon={<BotIcon />} />}
      title="Who the agent is"
      meta={[
        resolved.identity
          ? firstLine(resolved.identity)
          : "OpenGeni's general assistant (the default)",
        resolved.source === "legacy_agent_instructions"
          ? "from this workspace's earlier custom persona"
          : null,
        canManage ? null : "Only workspace admins can change this",
      ]}
      {...(canManage
        ? {
            indicator: "open" as const,
            onOpen: () =>
              void navigate({
                to: "/workspaces/$workspaceId/settings",
                params: { workspaceId },
                search: { section: "general", view: "agent-defaults" },
              }),
          }
        : {})}
    />
  );
}

/** "Ask OpenGeni…": starts a chat that proposes the change, on the workspace's model. */
function AskOpenGeniDialog({
  open,
  onOpenChange,
  workspaceId,
  personal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  personal: boolean;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const copy = promptCopy("workspace_instructions", personal);
  const catalog = useAgentBrainPromptCatalog(workspaceId);
  const [request, setRequest] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const model = useMemo(
    () =>
      catalog.loading || catalog.error
        ? null
        : resolveAgentBrainPromptModel(catalog.models, {
            model: context.model,
            reasoningEffort: context.reasoningEffort,
            latencyMode: context.latencyMode,
          }),
    [
      catalog.loading,
      catalog.error,
      catalog.models,
      context.model,
      context.reasoningEffort,
      context.latencyMode,
    ],
  );
  const unavailable = !catalog.loading && !catalog.error && model === null;
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setRequest("");
          setFieldError(null);
        }
      }}
      size="sm"
      title="Ask Opengeni to change the instructions"
      description="It starts a chat that proposes the change. Your Learning setting decides whether it applies right away or waits in Review."
      submitLabel="Start chat"
      pendingLabel="Starting…"
      submitDisabled={catalog.loading || model === null || context.busy}
      disabledReason={
        unavailable
          ? "No model is available in this workspace. Check Models in workspace settings."
          : catalog.error
            ? "Couldn't load the workspace's models. Close this and try again."
            : undefined
      }
      footerStart={
        model ? (
          <>
            Uses {model.label} · {model.paymentSource}
          </>
        ) : undefined
      }
      onSubmit={async () => {
        const trimmed = request.trim();
        if (!trimmed) {
          setFieldError("Describe the change you want.");
          return false;
        }
        if (!model) return false;
        const created = await context.startSession(
          workspaceId,
          {
            text: copy.openingMessage(trimmed),
            model: model.model,
            reasoningEffort: model.reasoningEffort,
            latencyMode: model.latencyMode,
          },
          { instructions: copy.instructions },
        );
        if (!created) throw new Error("Couldn't start the chat. Try again.");
        await navigate({
          to: "/workspaces/$workspaceId/sessions/$sessionId",
          params: { workspaceId, sessionId: created.id },
        });
        return true;
      }}
    >
      <Field label="What should change?" error={fieldError ?? undefined}>
        <TextArea
          rows={3}
          value={request}
          placeholder="For example: pull requests need a linked Linear issue"
          onChange={(event) => {
            setRequest(event.target.value);
            setFieldError(null);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/* -------------------------------------------------------------- edit page */

export function InstructionsEditPage({
  workspaceName,
  personal,
  instructions,
  onClose,
}: {
  workspaceName: string;
  personal: boolean;
  instructions: WorkspaceInstructions;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => {
    if (!instructions.loading && draft === null) setDraft(instructions.content);
  }, [instructions.loading, instructions.content, draft]);
  const value = draft ?? "";
  const tooLong = value.length > WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS;
  const limit = WORKSPACE_INSTRUCTION_POLICY_CONTENT_MAX_CHARS.toLocaleString("en-US");
  const unchanged = value.trim() === instructions.content.trim();
  return (
    <FormPage
      title={
        instructions.configured ? "Edit workspace instructions" : "Write workspace instructions"
      }
      description={`Added to every chat and schedule in ${personal ? "your Personal workspace" : workspaceName}. The old version stays in History.`}
      back={{ label: "Instructions", onClick: onClose }}
      submitLabel="Save instructions"
      pendingLabel="Saving…"
      loading={draft === null}
      loadingFields={1}
      submitDisabled={unchanged || !value.trim() || tooLong}
      // Cancel and Save show once something changed; until then the back link is the way out.
      className={unchanged ? "[&>form>footer]:hidden" : undefined}
      onCancel={onClose}
      onSubmitted={() => {
        toast("Saved the instructions. New messages use them.");
        onClose();
      }}
      onSubmit={async () => {
        await instructions.save(value);
        return true;
      }}
    >
      <Field
        label="Instructions"
        hint="Markdown. Headings and bullets read as they look. Agents follow these in every chat."
        error={
          tooLong
            ? `Keep instructions under ${limit} characters. Move long procedures into a skill.`
            : undefined
        }
        aside={`${value.length.toLocaleString("en-US")} / ${limit}`}
      >
        <TextArea
          mono
          rows={16}
          value={value}
          placeholder="For example: Keep updates concise, explain important decisions, and surface blockers early."
          onChange={(event) => setDraft(event.target.value)}
        />
      </Field>
    </FormPage>
  );
}

/* ----------------------------------------------------------- history page */

function sameTarget(item: { kind: string; scope: string; roleKey: string | null }) {
  return item.kind === "policy" && item.scope === "global" && item.roleKey === null;
}

export function instructionRevisions(
  response: WorkspaceInstructionPolicyListResponse,
  me: string | undefined,
): Array<Revision & { revisionId: string }> {
  const byId = new Map(response.revisions.map((revision) => [revision.id, revision]));
  return response.activationEvents
    .filter(sameTarget)
    .sort((left, right) => right.activationVersion - left.activationVersion)
    .flatMap((event, index, events) => {
      const revision = byId.get(event.newRevision.id);
      if (!revision) return [];
      const agent =
        revision.provenance.source === "agent_learning" ||
        revision.provenance.source === "knowledge_proposal";
      const author =
        event.actorSubjectId === me
          ? "You"
          : event.actorSubjectId.startsWith("service:") || agent
            ? "Opengeni"
            : revision.provenance.source === "onboarding"
              ? "Workspace setup"
              : "A workspace admin";
      const summary =
        event.type === "rollback"
          ? "Restored an earlier version"
          : index === events.length - 1
            ? "Created the instructions"
            : agent
              ? "Approved an agent's change"
              : revision.provenance.source === "legacy_import"
                ? "Brought over from earlier settings"
                : "Edited the instructions";
      return [
        {
          id: event.id,
          revisionId: revision.id,
          author,
          createdAt: event.createdAt,
          summary,
          content: revision.content,
        },
      ];
    });
}

export function InstructionsHistoryPage({
  workspaceId,
  workspaceName,
  canEdit,
  instructions,
  onClose,
}: {
  workspaceId: string;
  workspaceName: string;
  canEdit: boolean;
  instructions: WorkspaceInstructions;
  onClose: () => void;
}) {
  const context = useAppContext();
  const [response, setResponse] = useState<WorkspaceInstructionPolicyListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setError(null);
    void context.client
      .listWorkspaceInstructionPolicies(workspaceId, {
        kind: "policy",
        scope: "global",
        limit: 100,
      })
      .then((value) => {
        if (current) setResponse(value);
      })
      .catch((reason: unknown) => {
        if (current) setError(errorText(reason));
      });
    return () => {
      current = false;
    };
  }, [context.client, workspaceId, retry]);
  const revisions = useMemo(
    () => (response ? instructionRevisions(response, context.accessContext.subjectId) : []),
    [response, context.accessContext.subjectId],
  );
  const head = response?.activeHeads.find(sameTarget) ?? null;
  const latest = revisions[0];
  return (
    <DetailPage back={{ label: "Instructions", onClick: onClose }}>
      <DetailPageHeader
        leading={<LogoTile icon={<HistoryIcon />} />}
        title="Instructions history"
        meta={[
          `in ${workspaceName}`,
          response
            ? `${revisions.length} ${revisions.length === 1 ? "version" : "versions"}`
            : null,
          latest ? `last by ${latest.author === "You" ? "you" : latest.author}` : null,
        ]}
      />
      <DetailPageBody>
        <DetailSection description="Restoring saves that version again as the newest one, so you can always go back.">
          <RevisionHistory
            revisions={revisions}
            loading={!response && !error}
            error={
              error && !response
                ? {
                    message: "Couldn't load the history",
                    detail: error,
                    onRetry: () => setRetry((value) => value + 1),
                  }
                : undefined
            }
            label="Workspace instructions history"
            restoreDisabledReason={
              !canEdit
                ? "Only workspace admins can restore a version."
                : !head
                  ? "The instructions are turned off right now. Write new ones to start again."
                  : undefined
            }
            onRestore={
              canEdit && head
                ? async (revision) => {
                    const target = revisions.find((each) => each.id === revision.id);
                    if (!target) return;
                    try {
                      const result =
                        await context.client.rollbackWorkspaceInstructionPolicyRevision(
                          workspaceId,
                          {
                            operationId: crypto.randomUUID(),
                            targetRevisionId: target.revisionId,
                            expectedCurrentRevisionId: head.revisionId,
                            expectedActivationVersion: head.activationVersion,
                            reason: "Restored an earlier version from Knowledge history",
                          },
                        );
                      instructions.accept(result.head);
                      const before = head.revisionId;
                      showUndoToast({
                        title: "Restored an earlier version",
                        description: "New messages use it.",
                        onUndo: () => {
                          void context.client
                            .rollbackWorkspaceInstructionPolicyRevision(workspaceId, {
                              operationId: crypto.randomUUID(),
                              targetRevisionId: before,
                              expectedCurrentRevisionId: result.head.revisionId,
                              expectedActivationVersion: result.head.activationVersion,
                              reason: "Undid a restore from Knowledge history",
                            })
                            .then((undone) => {
                              instructions.accept(undone.head);
                              setRetry((value) => value + 1);
                            })
                            .catch((reason: unknown) =>
                              toast.error("Couldn't undo the restore", {
                                description: errorText(reason),
                              }),
                            );
                        },
                      });
                    } catch (reason) {
                      toast.error("Couldn't restore that version", {
                        description: errorText(reason),
                      });
                    } finally {
                      setRetry((value) => value + 1);
                    }
                  }
                : undefined
            }
          />
        </DetailSection>
      </DetailPageBody>
    </DetailPage>
  );
}
