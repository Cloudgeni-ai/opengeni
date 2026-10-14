/**
 * Session dock > Agent > Usage: this chat's usage limit. The main task (root)
 * owns one limit for itself and all its agents; a sub-agent shows the main
 * task's limit read-only with a link to it. Saving never resumes work: a goal
 * paused at the limit keeps its Resume action, and a chat without a goal
 * continues on the next message.
 */
import {
  DEFAULT_SESSION_USAGE_LIMIT_LABELS as LABELS,
  summarizeSessionUsageLimit,
} from "@opengeni/react/usage";
import {
  formatSessionUsageMicros,
  type SessionUsageLimit,
} from "@opengeni/sdk/session-usage-limits";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Field, TextInput } from "@/components/ui/field";
import { HelpLink, HelpTip, InlineHelp } from "@/components/ui/inline-help";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow } from "@/components/ui/setting-row";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { useAppContext } from "@/context";
import { hasWorkspacePermission } from "@/lib/permissions";
import {
  classifySessionUsageLimitSaveError,
  isOutcomeUnknown,
  parseSessionUsageLimitDraft,
  sessionUsageLimitCapability,
  sessionUsageLimitInputValue,
  useSessionUsageLimit,
  type SessionUsageLimitDraft,
  type SessionUsageLimitSaveFailure,
} from "@/lib/session-usage-limit";
import { cn } from "@/lib/utils";
import type { Session } from "@/types";

const DISABLED_REASON = "New limits are turned off here. You can still remove a limit.";

type EditBase = { version: number; limitMicros: number | null };
type PendingSave = { operationId: string; limitMicros: number | null; expectedVersion: number };

/** Waits before re-sending a save whose outcome is unknown (same operation). */
export const SESSION_USAGE_LIMIT_UNKNOWN_RETRY_MS = [500, 1_500] as const;

function limitText(limitMicros: number | null): string {
  return limitMicros === null ? "no limit" : formatSessionUsageMicros(limitMicros);
}

export function sessionHref(workspaceId: string, sessionId: string): string {
  return `/workspaces/${workspaceId}/sessions/${sessionId}`;
}

export function SessionUsageLimitSection(props: {
  session: Session;
  /** A new value (header menu, composer notice) opens the editor and focuses it. */
  focusRequest?: number;
  /** The goal is paused at the limit: after a save, say Resume is next. */
  goalPausedAtLimit?: boolean;
}) {
  const { session } = props;
  const context = useAppContext();
  const capability = sessionUsageLimitCapability(context.clientConfig);
  const canControl = hasWorkspacePermission(
    context.accessContext,
    session.workspaceId,
    "sessions:control",
  );
  const limit = useSessionUsageLimit({
    client: context.client,
    workspaceId: session.workspaceId,
    sessionId: session.id,
    initial: session.usageLimit,
    enabled: capability !== "absent",
  });
  const { usage, refresh } = limit;
  // The chat route reads it; read once here when nothing has been read yet.
  useEffect(() => {
    if (capability !== "absent" && !usage) void refresh();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only when the task changes
  }, [capability, session.id]);

  const child = Boolean(session.parentSessionId) || usage?.inherited === true;
  const rootSessionId = usage?.rootSessionId ?? null;
  const editable = capability !== "absent" && canControl && !child && usage !== null;
  // A refresh failed after a good read: keep the last known amount (and any
  // reached state), labelled as possibly out of date. Never $0.
  const stale = usage !== null && limit.error !== null;
  const summary = summarizeSessionUsageLimit(usage, undefined, { stale });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SessionUsageLimitDraft>({ kind: "none" });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SessionUsageLimitSaveFailure | null>(null);
  const [touched, setTouched] = useState(false);
  // What the person started editing from. Save sends this version, never one
  // a background refresh advanced meanwhile, so someone else's change in the
  // meantime is a conflict, not a silent overwrite.
  const [editBase, setEditBase] = useState<EditBase | null>(null);
  // A save whose response was lost: an exact retry reuses its operationId so
  // it can never apply twice; any other request gets a new one.
  const pendingSave = useRef<PendingSave | null>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const amountInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const statusId = useId();

  const openEditor = () => {
    if (usage) setEditBase({ version: usage.version, limitMicros: usage.limitMicros });
    pendingSave.current = null;
    setDraft(
      usage?.limitMicros === null || usage?.limitMicros === undefined
        ? { kind: "none" }
        : { kind: "limit", text: sessionUsageLimitInputValue(usage.limitMicros) },
    );
    setFailure(null);
    setTouched(false);
    setEditing(true);
  };
  const closeEditor = () => {
    setEditing(false);
    setFailure(null);
    requestAnimationFrame(() => changeButton.current?.focus({ preventScroll: true }));
  };

  // Header menu / composer notice: open the editor here and put focus in it.
  const focusRequest = props.focusRequest ?? 0;
  const handledFocus = useRef(0);
  // Focus after the render that shows the editor, not in the same frame as opening it.
  const [focusNonce, setFocusNonce] = useState(0);
  useEffect(() => {
    if (!focusRequest || handledFocus.current === focusRequest) return;
    if (capability === "absent") return;
    if (editable === false && usage === null && !limit.error) return; // wait for the read
    handledFocus.current = focusRequest;
    if (editable && !editing) openEditor();
    setFocusNonce((current) => current + 1);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- run per request
  }, [focusRequest, editable, usage === null, limit.error]);
  useEffect(() => {
    if (!focusNonce) return;
    const frame = requestAnimationFrame(() => {
      rootRef.current?.scrollIntoView({ block: "nearest" });
      const target =
        editorRef.current?.querySelector<HTMLElement>(
          '[role="radio"][aria-checked="true"], [data-state="on"]',
        ) ??
        changeButton.current ??
        rootRef.current?.querySelector<HTMLElement>("a, button");
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusNonce]);

  useEffect(() => {
    if (editing && draft.kind === "limit" && touched) amountInput.current?.focus();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- focus when "Pause at" is chosen
  }, [draft.kind]);

  if (capability === "absent") return null;

  const parsed = parseSessionUsageLimitDraft(draft);
  const draftMicros = parsed.ok ? parsed.limitMicros : undefined;
  const unchanged = parsed.ok && draftMicros === (usage?.limitMicros ?? null);
  const settingBlocked = capability === "disabled" && draft.kind === "limit";
  const amountError =
    draft.kind === "limit" && !parsed.ok && (touched || draft.text.trim()) ? parsed.error : null;

  async function save() {
    if (!usage || saving || !parsed.ok || settingBlocked) return;
    const base = editBase ?? { version: usage.version, limitMicros: usage.limitMicros };
    const request = { limitMicros: parsed.limitMicros, expectedVersion: base.version };
    const previous = pendingSave.current;
    const operationId =
      previous &&
      previous.limitMicros === request.limitMicros &&
      previous.expectedVersion === request.expectedVersion
        ? previous.operationId
        : crypto.randomUUID();
    pendingSave.current = { ...request, operationId };
    setSaving(true);
    setFailure(null);
    try {
      let committed: SessionUsageLimit | null = null;
      for (let attempt = 0; committed === null; attempt += 1) {
        try {
          committed = await context.client.setSessionUsageLimit(session.workspaceId, session.id, {
            ...request,
            operationId,
          });
        } catch (error) {
          // The response was lost: re-send the same operation, which the
          // server applies at most once, until it answers.
          const retryIn = SESSION_USAGE_LIMIT_UNKNOWN_RETRY_MS[attempt];
          if (!isOutcomeUnknown(error) || retryIn === undefined) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryIn));
        }
      }
      pendingSave.current = null;
      limit.apply(committed);
      closeEditor();
      const title =
        committed.limitMicros === null
          ? "Usage limit removed"
          : `Usage limit set to ${formatSessionUsageMicros(committed.limitMicros)}`;
      toast.success(
        title,
        props.goalPausedAtLimit ? { description: "Resume the goal to continue." } : undefined,
      );
    } catch (error) {
      const classified = classifySessionUsageLimitSaveError(error);
      // Still unknown: keep the operation so Save again is the same request.
      if (classified.kind !== "unknown") pendingSave.current = null;
      if (classified.kind === "conflict") {
        // Someone else saved meanwhile. Show theirs and keep this draft; the
        // next Save is a deliberate choice to replace it.
        const latest = await refresh();
        if (latest && latest.version !== base.version) {
          setEditBase({ version: latest.version, limitMicros: latest.limitMicros });
          setFailure({
            ...classified,
            message: `Someone changed this limit to ${limitText(latest.limitMicros)} while you were editing. Save again to use your amount instead.`,
          });
        } else {
          setFailure(classified);
        }
      } else {
        setFailure(classified);
        if (classified.kind === "preparing") void refresh();
      }
    } finally {
      setSaving(false);
    }
  }

  const limitLine =
    usage === null
      ? null
      : usage.limitMicros === null
        ? LABELS.noLimit
        : LABELS.pauseAt(formatSessionUsageMicros(usage.limitMicros));
  // With a limit and known usage the amount leads ("$12.34 of $50.00");
  // otherwise the limit leads and the usage (or why it's unknown) follows.
  const amountLeads =
    summary.state === "within" || summary.state === "near" || summary.state === "reached";
  const primaryLine = amountLeads ? summary.amountText : limitLine;
  const secondaryLine = amountLeads ? null : summary.amountText;

  const value =
    usage === null ? (
      limit.error ? (
        <InlineHelp
          action={
            <HelpLink onClick={() => void refresh()} className="text-xs">
              Try again
            </HelpLink>
          }
        >
          Couldn't read this chat's usage limit.
        </InlineHelp>
      ) : (
        <Skeleton className="h-4 w-40" aria-label="Loading usage limit" />
      )
    ) : (
      <div
        id={statusId}
        data-usage-limit-state={summary.state}
        className="flex min-w-0 flex-col gap-1.5"
      >
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm leading-5 text-fg">
          <span data-usage-limit-amount>{primaryLine}</span>
          {summary.state === "reached" ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-status-waiting">
              <StatusDot tone="waiting" size="sm" />
              Reached
            </span>
          ) : null}
        </p>
        {summary.barFraction !== null ? (
          <div
            aria-hidden="true"
            className="h-1 w-full max-w-60 overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className={cn(
                "h-full rounded-full",
                summary.state === "reached" ? "bg-status-waiting" : "bg-brand",
              )}
              style={{ width: `${Math.round(summary.barFraction * 100)}%` }}
            />
          </div>
        ) : null}
        {secondaryLine ? (
          <p className="text-xs leading-4.5 text-fg-muted">{secondaryLine}</p>
        ) : null}
        {summary.notes
          .filter((note) => !(summary.stale && note === LABELS.staleNote))
          .map((note) => (
            <p key={note} className="text-xs leading-4.5 text-fg-muted">
              {note}
            </p>
          ))}
        {summary.stale ? (
          <InlineHelp
            action={
              <HelpLink onClick={() => void refresh()} className="text-xs">
                Try again
              </HelpLink>
            }
          >
            <span data-usage-limit-stale>{LABELS.staleNote}</span>
          </InlineHelp>
        ) : null}
        {child && rootSessionId ? (
          <InlineHelp
            action={
              <HelpLink href={sessionHref(session.workspaceId, rootSessionId)} className="text-xs">
                {LABELS.openMainTask}
              </HelpLink>
            }
          >
            Set on the main task for it and all its agents.
          </InlineHelp>
        ) : !child && !canControl ? (
          <InlineHelp>Changing it needs permission to run this chat.</InlineHelp>
        ) : null}
      </div>
    );

  return (
    <div ref={rootRef} data-session-usage-limit className="-mt-3 flex min-w-0 flex-col">
      <SettingRow
        label={
          <span className="inline-flex items-center gap-1.5">
            {LABELS.title}
            <HelpTip label="About usage limits">{LABELS.notYourBill}</HelpTip>
          </span>
        }
        description={LABELS.explanation}
        control={
          editable && !editing ? (
            <Button
              ref={changeButton}
              type="button"
              variant="outline"
              size="sm"
              className="pointer-coarse:h-11"
              aria-describedby={statusId}
              onClick={openEditor}
            >
              Change
            </Button>
          ) : undefined
        }
      />
      <div className="pb-1">{value}</div>
      {editing && usage ? (
        <div
          ref={editorRef}
          data-usage-limit-editor
          role="group"
          aria-label="Change usage limit"
          className="mt-4 flex min-w-0 flex-col gap-4 pb-1"
        >
          {failure ? (
            <p role="alert" className="text-xs leading-4.5 text-danger">
              {failure.message}{" "}
              {failure.kind === "not_root" && failure.rootSessionId ? (
                <HelpLink
                  href={sessionHref(session.workspaceId, failure.rootSessionId)}
                  className="text-xs"
                >
                  {LABELS.openMainTask}
                </HelpLink>
              ) : null}
            </p>
          ) : null}
          <Field label="Limit" group>
            <SegmentedControl
              size="sm"
              value={draft.kind}
              disabled={saving}
              onValueChange={(kind) => {
                setFailure(null);
                setTouched(true);
                setDraft((current) =>
                  kind === "none"
                    ? { kind: "none" }
                    : current.kind === "limit"
                      ? current
                      : {
                          kind: "limit",
                          text:
                            usage.limitMicros === null
                              ? ""
                              : sessionUsageLimitInputValue(usage.limitMicros),
                        },
                );
              }}
              options={[
                { value: "none", label: LABELS.noLimit },
                {
                  value: "limit",
                  label: "Pause at",
                  disabled: capability === "disabled",
                  disabledReason: capability === "disabled" ? DISABLED_REASON : undefined,
                },
              ]}
            />
          </Field>
          {draft.kind === "limit" ? (
            <Field label="Limit in US dollars" error={amountError ?? undefined}>
              <div className="relative max-w-60">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-fg-muted"
                >
                  $
                </span>
                <TextInput
                  ref={amountInput}
                  value={draft.text}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="25.00"
                  disabled={saving || capability === "disabled"}
                  className="pl-6"
                  onChange={(event) => {
                    setFailure(null);
                    setDraft({ kind: "limit", text: event.target.value });
                  }}
                  onBlur={() => setTouched(true)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      setTouched(true);
                      void save();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      closeEditor();
                    }
                  }}
                />
              </div>
            </Field>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="pointer-coarse:h-11"
              disabled={saving}
              onClick={closeEditor}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="pointer-coarse:h-11"
              disabled={saving || !parsed.ok || unchanged || settingBlocked}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
