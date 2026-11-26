/**
 * The Enable page as drawn (./enable-subject.ts has its logic, ./enable-page.tsx
 * reads the workspace and runs its actions). Steps Connect, Check, Turn on;
 * one primary, Turn on, with the reason it is off in words beside it.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import { SETUP_GUARDRAIL_UNATTENDED_NOTE, type SetupGuardrail } from "@opengeni/contracts";
import type { SetupConnectionState, SetupReadiness } from "@opengeni/sdk";

import { cn } from "@opengeni/react/app/lib/utils";
import { Button } from "@opengeni/react/ui/button";
import { DetailPage, DetailPageHeader, type DetailBackLink } from "@opengeni/react/ui/detail-page";
import { DetailFooter, DetailSection } from "@opengeni/react/ui/detail-sheet";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { Notice } from "@opengeni/react/ui/notice";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { SettingRow, SettingRowSkeleton } from "@opengeni/react/ui/setting-row";
import { StatusBadge } from "@opengeni/react/ui/status-badge";

import {
  ENABLE_STEPS,
  connectControlOf,
  orderedConnections,
  requiredSummary,
  type EnableStage,
  type EnableStep,
} from "./enable-subject";

export type EnableFact = { label: string; description?: string | undefined };

/** How an admin was asked: in their inbox, or by a link the person sends. */
export type AskedVia = "inbox" | "already" | "link";

export interface EnableViewProps {
  /** "PR reviewer", "Review pull requests". */
  name: string;
  description: string;
  icon?: ReactNode | undefined;
  back?: DetailBackLink | undefined;
  /** The step the address names; the page scrolls to it. */
  step?: EnableStep | undefined;
  /** Null while it loads, or when it couldn't be read (then `loadError`). */
  readiness: SetupReadiness | null;
  loading: boolean;
  loadError?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /** A repository its trigger needs: "required" adds a row to Connect. */
  repository?: "required" | "optional" | null | undefined;
  /** What gets set up, as label and line. */
  facts: readonly EnableFact[];
  wontDoWithoutAsking: readonly SetupGuardrail[];
  /** One optional line, display only: "Works well with PR reviewer". */
  worksWellWith?: { name: string; onOpen: () => void } | null | undefined;
  stage: EnableStage;
  /** Why Turn on is off, in words; null when it can be pressed. */
  blocker: string | null;
  busy: boolean;
  /** Providers an admin was asked about from here, and how. */
  asked: ReadonlyMap<string, AskedVia>;
  onConnect: (connection: SetupConnectionState) => void;
  /** Absent in a Personal workspace, where there is no admin to ask. */
  onAskAdmin?: ((connection: SetupConnectionState) => void) | undefined;
  onTurnOn: () => void;
  /** Keeps it added but off. Absent for apps, which have nothing to keep off. */
  onFinishLater?: (() => void) | undefined;
  /** Once on: the one primary and one suggested small first job. */
  done: {
    title: string;
    open: { label: string; onClick: () => void };
    firstJob?: { text: string; onStart: () => void } | null | undefined;
  };
}

function Stepper({ stage }: { stage: EnableStage }) {
  const doneUpTo = stage === "on" ? 3 : stage === "turn-on" ? 1 : 0;
  return (
    <ol aria-label="Steps" className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-2 sm:gap-x-3">
      {ENABLE_STEPS.map((entry, index) => {
        const done = index < doneUpTo;
        const current = index === doneUpTo;
        return (
          <li
            key={entry.key}
            aria-current={current ? "step" : undefined}
            data-enable-step={entry.key}
            data-state={done ? "done" : current ? "current" : "next"}
            className="flex items-center gap-2 sm:gap-3"
          >
            {index > 0 ? <span aria-hidden="true" className="h-px w-4 bg-border sm:w-8" /> : null}
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-6 items-center justify-center rounded-full border text-xs font-medium",
                  done
                    ? "border-fg bg-fg text-bg"
                    : current
                      ? "border-fg text-fg"
                      : "border-border text-fg-muted",
                )}
              >
                {done ? <CheckIcon className="size-3.5" /> : index + 1}
              </span>
              <span
                className={cn(
                  "text-sm",
                  current ? "font-semibold text-fg" : done ? "text-fg" : "text-fg-muted",
                )}
              >
                {entry.label}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ConnectionRow({
  connection,
  asked,
  onConnect,
  onAskAdmin,
}: {
  connection: SetupConnectionState;
  asked: AskedVia | undefined;
  onConnect: () => void;
  onAskAdmin: (() => void) | undefined;
}) {
  const control = connectControlOf(connection);
  return (
    <SettingRow
      data-enable-connection={connection.provider}
      label={
        <span className="inline-flex flex-wrap items-center gap-2">
          {connection.name}
          <MetaChip variant="outline">{connection.required ? "Required" : "Optional"}</MetaChip>
        </span>
      }
      description={
        control === "not-offered"
          ? `${connection.name} isn't offered here.`
          : control === "ask-admin" && !onAskAdmin
            ? // A Personal workspace has no admin to ask: an organization setting blocks it.
              `Your organization lets only admins connect ${connection.name}.`
            : connection.why
      }
      control={
        control === "connected" ? (
          <StatusBadge tone="success" variant="dot">
            Connected
          </StatusBadge>
        ) : control === "connect" ? (
          <RowButton onClick={onConnect}>Connect</RowButton>
        ) : control === "ask-admin" && onAskAdmin ? (
          asked ? (
            <StatusBadge tone="neutral" variant="dot">
              {asked === "inbox"
                ? "Requested"
                : asked === "already"
                  ? "Already asked"
                  : "Link copied"}
            </StatusBadge>
          ) : (
            <RowButton onClick={onAskAdmin}>Ask an admin</RowButton>
          )
        ) : undefined
      }
      hint={
        control === "ask-admin" && asked
          ? asked === "link"
            ? "Send the link to an admin to connect it."
            : "Your admins were asked in their inbox."
          : undefined
      }
    />
  );
}

export function EnableView(props: EnableViewProps) {
  const {
    name,
    description,
    icon,
    back,
    step,
    readiness,
    loading,
    loadError,
    onRetry,
    repository,
    facts,
    wontDoWithoutAsking,
    worksWellWith,
    stage,
    blocker,
    busy,
    asked,
    onConnect,
    onAskAdmin,
    onTurnOn,
    onFinishLater,
    done,
  } = props;
  const sections = useRef<Partial<Record<EnableStep, HTMLDivElement | null>>>({});
  // Coming back from Connect, or from a link to a step, lands on that step.
  useEffect(() => {
    if (!step || loading || step === "connect") return;
    sections.current[step]?.scrollIntoView?.({ block: "start" });
  }, [loading, step]);

  const header = (
    <>
      <DetailPageHeader
        leading={<LogoTile name={name} icon={icon} />}
        title={stage === "on" ? done.title : `Set up ${name}`}
        meta={[description]}
      />
      <Stepper stage={stage} />
    </>
  );

  if (stage === "on") {
    return (
      <DetailPage back={back}>
        {header}
        <Notice tone="success" className="mt-6">
          {done.title}
        </Notice>
        {done.firstJob ? (
          <DetailSection title="Try a first job">
            <SettingRow
              data-enable-first-job=""
              label={done.firstJob.text}
              control={<RowButton onClick={done.firstJob.onStart}>Start</RowButton>}
            />
          </DetailSection>
        ) : null}
        <DetailFooter>
          <Button type="button" onClick={done.open.onClick}>
            {done.open.label}
          </Button>
        </DetailFooter>
      </DetailPage>
    );
  }

  const summary = readiness ? requiredSummary(readiness) : null;
  const connections = readiness ? orderedConnections(readiness) : [];
  return (
    <DetailPage back={back}>
      {header}
      <div
        ref={(node) => {
          sections.current.connect = node;
        }}
      >
        <DetailSection
          title="Connect"
          description={
            loading ? undefined : (summary ?? (connections.length ? "Nothing required." : null))
          }
        >
          {loading ? (
            <SettingRowSkeleton />
          ) : loadError ? (
            <Notice tone="failed">
              {loadError}{" "}
              {onRetry ? (
                <button type="button" className="og-link" onClick={onRetry}>
                  Try again
                </button>
              ) : null}
            </Notice>
          ) : connections.length === 0 && repository !== "required" ? (
            <p className="text-sm text-fg-muted">Nothing to connect.</p>
          ) : (
            <>
              {connections.map((connection) => (
                <ConnectionRow
                  key={connection.provider}
                  connection={connection}
                  asked={asked.get(connection.provider)}
                  onConnect={() => onConnect(connection)}
                  onAskAdmin={onAskAdmin ? () => onAskAdmin(connection) : undefined}
                />
              ))}
              {repository === "required" ? (
                <SettingRow
                  data-enable-repository=""
                  label={
                    <span className="inline-flex flex-wrap items-center gap-2">
                      Repository
                      <MetaChip variant="outline">Required</MetaChip>
                    </span>
                  }
                  description="You choose it when you turn it on."
                />
              ) : null}
            </>
          )}
        </DetailSection>
      </div>
      <div
        ref={(node) => {
          sections.current.check = node;
        }}
      >
        <DetailSection title="What gets set up">
          {facts.map((fact) => (
            <SettingRow key={fact.label} label={fact.label} description={fact.description} />
          ))}
          {worksWellWith ? (
            <p className="mt-3 text-xs text-fg-muted">
              Works well with{" "}
              <button type="button" className="og-link" onClick={worksWellWith.onOpen}>
                {worksWellWith.name}
              </button>
              . Not needed.
            </p>
          ) : null}
        </DetailSection>
        {wontDoWithoutAsking.length > 0 ? (
          <DetailSection
            title="What it won't do without asking"
            description={
              wontDoWithoutAsking.some((line) => line.permission === "ask")
                ? SETUP_GUARDRAIL_UNATTENDED_NOTE
                : undefined
            }
          >
            <ul className="flex flex-col gap-2 text-sm text-fg">
              {wontDoWithoutAsking.map((line) => (
                <li key={line.text} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">{line.text}</span>
                  <MetaChip variant="outline">
                    {line.permission === "block" ? "Never" : "Asks first"}
                  </MetaChip>
                </li>
              ))}
            </ul>
          </DetailSection>
        ) : null}
      </div>
      <div
        ref={(node) => {
          sections.current["turn-on"] = node;
        }}
      >
        <DetailFooter
          start={
            <>
              <Button
                type="button"
                data-enable-turn-on=""
                disabled={loading || busy || blocker !== null}
                aria-describedby={blocker ? "enable-turn-on-reason" : undefined}
                onClick={onTurnOn}
              >
                Turn on
              </Button>
              {blocker ? (
                <span id="enable-turn-on-reason" className="text-sm text-fg-muted">
                  {blocker}
                </span>
              ) : null}
            </>
          }
        >
          {onFinishLater ? (
            <Button type="button" variant="ghost" disabled={busy} onClick={onFinishLater}>
              Finish later
            </Button>
          ) : null}
        </DetailFooter>
      </div>
    </DetailPage>
  );
}
