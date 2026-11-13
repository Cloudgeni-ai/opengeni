import type { ConsoleSessionDetail, SessionEvent } from "@opengeni/sdk";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { EyeIcon, LockIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { MessageTimeline } from "@opengeni/react/session-ui";
import { Button } from "@opengeni/react/ui/button";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "@opengeni/react/ui/detail-page";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { Notice } from "@opengeni/react/ui/notice";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { Skeleton } from "@opengeni/react/ui/skeleton";

import {
  ConsoleLoadError,
  endUserLabel,
  formatCount,
  formatDuration,
  formatMicros,
  formatTokens,
  isReviewOff,
  useConsole,
  type ConsoleClient,
} from "./console-shared";
import { sessionStatus, sessionTitle } from "./sessions";

const EVENTS_PAGE = 500;

/** Every event of a transcript, oldest first, page by page. */
export async function loadConsoleTranscript(
  client: ConsoleClient,
  organizationId: string,
  workspaceId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await client.listConsoleSessionEvents(organizationId, workspaceId, sessionId, {
      after,
      limit: EVENTS_PAGE,
      ...(signal ? { signal } : {}),
    });
    events.push(...page.events);
    if (!page.hasMore || page.nextAfter === null || page.nextAfter <= after) return events;
    after = page.nextAfter;
  }
}

type DetailState = { key: string; promise: Promise<ConsoleSessionDetail> };

export function ConsoleSessionRoute() {
  const { client, organizationId, search } = useConsole();
  const navigate = useNavigate();
  const { workspaceId = "", sessionId = "" } = useParams({ strict: false }) as {
    workspaceId?: string;
    sessionId?: string;
  };
  const key = `${organizationId}/${workspaceId}/${sessionId}`;
  // Each open is written to the audit log: read the session once per open,
  // even when React runs the effect twice.
  const request = useRef<DetailState | null>(null);
  const [detail, setDetail] = useState<{ key: string; value: ConsoleSessionDetail } | null>(null);
  const [error, setError] = useState<{ key: string; error: unknown } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const requestKey = `${key}#${attempt}`;
    if (request.current?.key !== requestKey) {
      request.current = {
        key: requestKey,
        promise: client.getConsoleSession(organizationId, workspaceId, sessionId),
      };
    }
    let live = true;
    request.current.promise.then(
      (value) => {
        if (live) setDetail({ key, value });
      },
      (cause: unknown) => {
        if (live) setError({ key, error: cause });
      },
    );
    return () => {
      live = false;
    };
  }, [attempt, client, key, organizationId, sessionId, workspaceId]);

  const current = detail?.key === key ? detail.value : null;
  const failure = error?.key === key ? error.error : null;
  const full = current?.reviewLevel === "full";

  const [transcript, setTranscript] = useState<{
    key: string;
    events: SessionEvent[] | null;
    error: unknown;
  } | null>(null);
  const [transcriptAttempt, setTranscriptAttempt] = useState(0);
  useEffect(() => {
    if (!full) return;
    const controller = new AbortController();
    setTranscript({ key, events: null, error: null });
    loadConsoleTranscript(client, organizationId, workspaceId, sessionId, controller.signal).then(
      (events) => {
        if (!controller.signal.aborted) setTranscript({ key, events, error: null });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setTranscript({ key, events: null, error: cause });
      },
    );
    return () => controller.abort();
  }, [client, full, key, organizationId, sessionId, transcriptAttempt, workspaceId]);

  const back = {
    label: "Sessions",
    onClick: () => void navigate({ to: "/console/sessions", search }),
  };

  if (failure) {
    return (
      <DetailPage back={back} className="px-0 pt-0 max-sm:px-0">
        {isReviewOff(failure) ? (
          <EmptyState
            variant="page"
            icon={<LockIcon />}
            title="Session review is off"
            action={
              <Button variant="outline" asChild>
                <Link to="/console/settings" search={search}>
                  Data and privacy
                </Link>
              </Button>
            }
          />
        ) : (
          <ConsoleLoadError
            error={failure}
            onRetry={() => {
              setError(null);
              setAttempt((value) => value + 1);
            }}
          />
        )}
      </DetailPage>
    );
  }

  if (!current) {
    return (
      <DetailPage back={back} className="px-0 pt-0 max-sm:px-0">
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-7 w-80" />
          <Skeleton className="h-4 w-56" />
          <Skeleton className="mt-6 h-[420px] w-full rounded-lg" />
        </div>
      </DetailPage>
    );
  }

  const session = current.session;
  const events = transcript?.key === key ? transcript.events : null;
  const transcriptError = transcript?.key === key ? transcript.error : null;
  const model = current.models.length > 0 ? current.models.join(", ") : current.model;

  return (
    <DetailPage back={back} className="px-0 pt-0 max-sm:px-0">
      <DetailPageHeader
        title={sessionTitle(session)}
        chips={sessionStatus(session.status)}
        meta={[
          <RelativeTime key="started" date={session.createdAt} prefix="Started" />,
          `${formatCount(session.turns)} ${session.turns === 1 ? "turn" : "turns"}`,
        ]}
      />
      <DetailPageBody
        aside={
          <DetailAside>
            <DetailAsideItem label="Workspace">{session.workspaceName}</DetailAsideItem>
            <DetailAsideItem label="End user">{endUserLabel(session.endUser)}</DetailAsideItem>
            {model ? (
              <DetailAsideItem label="Model">
                {current.reasoningEffort ? `${model} · ${current.reasoningEffort}` : model}
              </DetailAsideItem>
            ) : null}
            <DetailAsideItem label="Duration">{formatDuration(current.durationMs)}</DetailAsideItem>
            <DetailAsideItem label="Tokens">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
                <dt className="text-fg-muted">Input</dt>
                <dd className="m-0 text-right">{formatTokens(current.tokens.input)}</dd>
                <dt className="text-fg-muted">Output</dt>
                <dd className="m-0 text-right">{formatTokens(current.tokens.output)}</dd>
                <dt className="text-fg-muted">Cached</dt>
                <dd className="m-0 text-right">{formatTokens(current.tokens.cached)}</dd>
                <dt className="text-fg-muted">Total</dt>
                <dd className="m-0 text-right">{formatTokens(current.tokens.total)}</dd>
              </dl>
            </DetailAsideItem>
            <DetailAsideItem label="Calls">
              {formatCount(current.modelCalls)} model · {formatCount(current.toolCalls)} tool
            </DetailAsideItem>
            <DetailAsideItem label="Cost">
              {formatMicros(session.costMicros, { precise: true })}
            </DetailAsideItem>
            {current.feedback.length > 0 ? (
              <DetailAsideItem label="Feedback">
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {current.feedback.map((feedback) => (
                    <li
                      key={`${feedback.createdAt}-${feedback.turnId ?? ""}-${feedback.sentiment ?? ""}`}
                      className="flex gap-2"
                    >
                      {feedback.sentiment === "negative" ? (
                        <ThumbsDownIcon
                          aria-label="Negative"
                          className="mt-0.5 size-3.5 shrink-0 text-danger"
                        />
                      ) : feedback.sentiment === "positive" ? (
                        <ThumbsUpIcon
                          aria-label="Positive"
                          className="mt-0.5 size-3.5 shrink-0 text-status-idle"
                        />
                      ) : null}
                      <span className="min-w-0 break-words">
                        {feedback.comment
                          ? `“${feedback.comment}”`
                          : feedback.sentiment === "negative"
                            ? "Negative"
                            : feedback.sentiment === "positive"
                              ? "Positive"
                              : "Feedback"}
                      </span>
                    </li>
                  ))}
                </ul>
              </DetailAsideItem>
            ) : null}
          </DetailAside>
        }
      >
        <div className="flex flex-col gap-3 pt-6">
          {full ? (
            transcriptError ? (
              <ConsoleLoadError
                error={transcriptError}
                onRetry={() => setTranscriptAttempt((value) => value + 1)}
              />
            ) : events ? (
              <div className="h-[600px] overflow-hidden rounded-[12px] border border-border">
                <MessageTimeline
                  events={events}
                  status="idle"
                  autoFollow={false}
                  className="h-full"
                />
              </div>
            ) : (
              <Skeleton className="h-[600px] w-full rounded-[12px]" />
            )
          ) : (
            <Notice tone="muted" icon={<LockIcon />}>
              Messages are hidden. Your organization shows metadata only.
            </Notice>
          )}
          {current.auditEventId ? (
            <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
              <EyeIcon aria-hidden="true" className="size-3.5" />
              Your view is recorded in the audit log.
            </p>
          ) : null}
        </div>
      </DetailPageBody>
    </DetailPage>
  );
}
