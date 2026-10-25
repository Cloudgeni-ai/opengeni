/**
 * Meetings: the recorder on top, then every meeting this person can see,
 * newest first. A row opens the meeting's own page. Rows still uploading or
 * transcribing say so and update on their own.
 */
import { useOpenGeniText } from "../messages/runtime";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AudioLinesIcon, LockIcon, SearchIcon, Trash2Icon } from "lucide-react";
import type { Recording } from "@opengeni/contracts";
import {
  formatDuration,
  meetingPhase,
  meetingStatusLabel,
  useRecordingModels,
  useRecordings,
  useRecordingsClient,
  type RecordingsClientOverride,
} from "../recordings";

import { Button } from "../ui/button";
import { DropdownMenuItem } from "../ui/dropdown-menu";
import { EmptyState } from "../ui/empty-state";
import { ErrorMessage } from "../ui/error-message";
import { inAppClick } from "../ui/in-app-click";
import { Input } from "../ui/input";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "../ui/list-row";
import { LogoTile } from "../ui/logo-tile";
import { MetaChip } from "../ui/meta-chip";
import { Notice } from "../ui/notice";
import { PageHeader } from "../ui/page-header";
import { RelativeTime } from "../ui/relative-time";
import { StatusBadge } from "../ui/status-badge";

import { DeleteMeetingDialog } from "./delete-meeting-dialog";
import { RecorderPanel } from "./recorder-panel";
import { useMeetingRecorder, usePendingMeetingStart } from "./recorder-context";

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function useNarrow(): boolean {
  const query = "(max-width: 639px)";
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true,
  );
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function MeetingsListPage({
  workspaceId,
  liveTranscriptDefault = false,
  liveTranscript = true,
  defaultLanguage = null,
  recordings: recordingsClient,
  meetingHref,
  onOpen,
  externalRef = null,
  notice = null,
  header = true,
}: {
  workspaceId: string;
  /** Whether the workspace shows a live transcript while recording by default. */
  liveTranscriptDefault?: boolean;
  /** Offer the live transcript preview at all; false hides it even when a live model is connected. */
  liveTranscript?: boolean;
  /** The workspace's meeting language; null detects it. */
  defaultLanguage?: string | null;
  /** A recordings client to use instead of the app's, for previews. */
  recordings?: RecordingsClientOverride["recordings"];
  meetingHref: (recordingId: string) => string;
  onOpen: (recordingId: string) => void;
  /**
   * Show only the meetings with this id of the host's, such as a project, and
   * give new recordings started here the same id.
   */
  externalRef?: string | null;
  /** A short line shown before every start, such as a reminder to tell the people present. */
  notice?: ReactNode;
  /** Show the page title; false when the list sits inside a page of the host's. */
  header?: boolean;
}) {
  const msg = useOpenGeniText();
  const columns: RowListColumn[] = [
    { id: "length", label: msg("meetings.listPage.length"), width: 96 },
    { id: "recorded", label: msg("meetings.listPage.recorded"), width: 148 },
  ];
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 250);
  const override = { workspaceId, ...(recordingsClient ? { recordings: recordingsClient } : {}) };
  const list = useRecordings({
    ...override,
    ...(query ? { query } : {}),
    ...(externalRef ? { externalRef } : {}),
  });
  const { client } = useRecordingsClient(override);
  const { recorder, finished } = useMeetingRecorder();
  const models = useRecordingModels(override);
  const liveModel = models.liveModels.find((entry) => entry.available) ?? null;
  // A desktop call notification's Record waits for the live model list, so
  // the recording gets the same live-preview default as a click on Start.
  const pendingStart = usePendingMeetingStart();
  const autoStart = useMemo(
    () => ({ pending: pendingStart.request !== null && !models.loading, take: pendingStart.take }),
    [pendingStart.request, pendingStart.take, models.loading],
  );
  const narrow = useNarrow();
  const [pendingDelete, setPendingDelete] = useState<Recording | null>(null);

  // A recording that finished uploading in this tab changes state on the server.
  const refresh = list.refresh;
  const finishedCount = finished.length;
  useEffect(() => {
    if (finishedCount > 0) void refresh();
  }, [finishedCount, refresh]);
  // A recording that just started shows up in the list as soon as the server has it.
  const liveId = recorder?.upload?.created ? recorder.recordingId : null;
  const lastLiveId = useRef<string | null>(null);
  useEffect(() => {
    if (liveId && liveId !== lastLiveId.current) {
      lastLiveId.current = liveId;
      void refresh();
    }
  }, [liveId, refresh]);

  const loading = list.loading && list.recordings.length === 0;
  const empty = !list.loading && !list.error && list.recordings.length === 0;

  return (
    <>
      {header ? (
        <PageHeader
          icon={<AudioLinesIcon />}
          title={msg("meetings.listPage.meetings")}
          description={msg("meetings.listPage.recordAMeetingAndGet")}
        />
      ) : null}
      <div className={header ? "mt-2 grid gap-8" : "grid gap-8"}>
        <RecorderPanel
          recorder={recorder}
          onStopped={onOpen}
          defaultLanguage={defaultLanguage}
          autoStart={autoStart}
          externalRef={externalRef}
          notice={notice}
          liveTranscript={
            liveTranscript && liveModel
              ? { defaultOn: liveTranscriptDefault, usdPerHour: liveModel.usdPerHour }
              : null
          }
        />
        {recorder && recorder.recovered.length > 0 ? (
          <Notice tone="info">
            {msg("meetings.listPage.earlierRecordingsWereStillSaved", {
              count: recorder.recovered.length,
            })}
          </Notice>
        ) : null}
        <div className="grid gap-3">
          {list.recordings.length > 0 || query ? (
            <div className="relative max-w-80">
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle"
              />
              <Input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={msg("meetings.listPage.searchMeetings")}
                aria-label={msg("meetings.listPage.searchMeetings")}
                className="h-9 pl-9 pointer-coarse:h-11"
              />
            </div>
          ) : null}
          {loading ? (
            <RowList
              label={msg("meetings.listPage.meetings")}
              columns={narrow ? [] : columns}
              flush
              busy
            >
              <ListRowSkeleton count={4} />
            </RowList>
          ) : list.error && list.recordings.length === 0 ? (
            <ErrorMessage
              align="center"
              title={msg("meetings.listPage.couldnTLoadMeetings")}
              details={[{ label: msg("meetings.listPage.error"), value: list.error.message }]}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void list.refresh()}
                  className="pointer-coarse:h-11"
                >
                  {msg("meetings.listPage.tryAgain")}
                </Button>
              }
            >
              {msg("meetings.listPage.checkYourConnectionThenTry")}
            </ErrorMessage>
          ) : empty ? (
            query ? (
              <EmptyState
                variant="inline"
                title={msg("meetings.listPage.noMeetingsMatchQuery", { query: query })}
                description={msg("meetings.listPage.searchFindsWordsInMeeting")}
              />
            ) : (
              <EmptyState
                variant="page"
                icon={<AudioLinesIcon />}
                title={msg("meetings.listPage.noMeetingsYet")}
                description={msg("meetings.listPage.startARecordingAboveWhen")}
                className="pt-8"
              />
            )
          ) : (
            <RowList
              label={msg("meetings.listPage.meetings")}
              columns={narrow ? [] : columns}
              flush
            >
              {list.recordings.map((recording) => {
                const status = meetingStatusLabel(meetingPhase(recording));
                const isLive = recording.id === liveId && recorder?.state !== "stopped";
                return (
                  <ListRow
                    key={recording.id}
                    leading={<LogoTile icon={<AudioLinesIcon />} />}
                    title={recording.title}
                    titleAddon={
                      recording.visibility === "private" ? (
                        <MetaChip icon={<LockIcon />}>
                          <span className={narrow ? "sr-only" : undefined}>
                            {msg("meetings.listPage.onlyMe")}
                          </span>
                        </MetaChip>
                      ) : undefined
                    }
                    status={
                      isLive ? (
                        <StatusBadge variant="dot" tone="danger" pulse>
                          {msg("meetings.listPage.recording")}
                        </StatusBadge>
                      ) : status ? (
                        <StatusBadge
                          variant="dot"
                          tone={status.tone}
                          pulse={status.tone === "progress"}
                        >
                          {status.label}
                        </StatusBadge>
                      ) : undefined
                    }
                    meta={
                      narrow
                        ? [
                            <RelativeTime key="recorded" date={recording.startedAt} />,
                            recording.durationMilliseconds > 0
                              ? formatDuration(recording.durationMilliseconds)
                              : null,
                          ].filter(Boolean)
                        : undefined
                    }
                    cells={{
                      length:
                        recording.durationMilliseconds > 0 ? (
                          <span className="tabular-nums">
                            {formatDuration(recording.durationMilliseconds)}
                          </span>
                        ) : (
                          <span className="text-fg-subtle">—</span>
                        ),
                      recorded: <RelativeTime date={recording.startedAt} />,
                    }}
                    menu={
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setPendingDelete(recording)}
                      >
                        <Trash2Icon aria-hidden="true" />
                        {msg("meetings.listPage.deleteMeeting")}
                      </DropdownMenuItem>
                    }
                    menuLabel={msg("meetings.listPage.moreActionsForTitle", {
                      title: recording.title,
                    })}
                    href={meetingHref(recording.id)}
                    linkProps={{ onClick: inAppClick(() => onOpen(recording.id)) }}
                  />
                );
              })}
            </RowList>
          )}
          {list.hasMore ? (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={list.loadingMore}
                onClick={() => void list.loadMore()}
                className="pointer-coarse:h-11"
              >
                {list.loadingMore
                  ? msg("meetings.listPage.loading")
                  : msg("meetings.listPage.showOlderMeetings")}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      <DeleteMeetingDialog
        recording={pendingDelete}
        onClose={() => setPendingDelete(null)}
        onDelete={async (recordingId) => {
          await client.deleteRecording(workspaceId, recordingId);
        }}
        onDeleted={() => void list.refresh()}
      />
    </>
  );
}
