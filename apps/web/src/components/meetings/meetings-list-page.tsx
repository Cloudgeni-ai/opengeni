/**
 * Meetings: the recorder on top, then every meeting this person can see,
 * newest first. A row opens the meeting's own page. Rows still uploading or
 * transcribing say so and update on their own.
 */
import { useEffect, useRef, useState } from "react";
import { AudioLinesIcon, LockIcon, SearchIcon, Trash2Icon } from "lucide-react";
import type { Recording } from "@opengeni/contracts";
import {
  useRecordings,
  useRecordingsClient,
  type RecordingsClientOverride,
} from "@opengeni/react/recordings";

import { Button } from "@opengeni/react/ui/button";
import { DropdownMenuItem } from "@opengeni/react/ui/dropdown-menu";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { inAppClick } from "@opengeni/react/ui/in-app-click";
import { Input } from "@opengeni/react/ui/input";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@opengeni/react/ui/list-row";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { MetaChip } from "@opengeni/react/ui/meta-chip";
import { Notice } from "@opengeni/react/ui/notice";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { StatusBadge } from "@opengeni/react/ui/status-badge";

import { DeleteMeetingDialog } from "./delete-meeting-dialog";
import { formatDuration, meetingPhase, meetingStatusLabel } from "./meeting-model";
import { RecorderPanel } from "./recorder-panel";
import { useMeetingRecorder } from "./recorder-context";

const COLUMNS: RowListColumn[] = [
  { id: "length", label: "Length", width: 96 },
  { id: "recorded", label: "Recorded", width: 148 },
];

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
  recordings: recordingsClient,
  meetingHref,
  onOpen,
}: {
  workspaceId: string;
  /** A recordings client to use instead of the app's, for previews. */
  recordings?: RecordingsClientOverride["recordings"];
  meetingHref: (recordingId: string) => string;
  onOpen: (recordingId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim(), 250);
  const override = { workspaceId, ...(recordingsClient ? { recordings: recordingsClient } : {}) };
  const list = useRecordings({ ...override, ...(query ? { query } : {}) });
  const { client } = useRecordingsClient(override);
  const { recorder, finished } = useMeetingRecorder();
  const narrow = useNarrow();
  const [pendingDelete, setPendingDelete] = useState<Recording | null>(null);

  // A recording that finished uploading in this tab changes state on the server.
  const refresh = list.refresh;
  const finishedCount = finished.length;
  useEffect(() => {
    if (finishedCount > 0) void refresh();
  }, [finishedCount, refresh]);
  // A recording that just started shows up in the list right away.
  const liveId = recorder?.recordingId ?? null;
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
      <PageHeader
        icon={<AudioLinesIcon />}
        title="Meetings"
        description="Record a meeting and get a transcript of who said what."
      />
      <div className="mt-2 grid gap-8">
        <RecorderPanel recorder={recorder} onStopped={onOpen} />
        {recorder && recorder.recovered.length > 0 ? (
          <Notice tone="info">
            {recorder.recovered.length === 1
              ? "An earlier recording was still saved in this browser. It's uploading now."
              : `${recorder.recovered.length} earlier recordings were still saved in this browser. They're uploading now.`}
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
                placeholder="Search meetings"
                aria-label="Search meetings"
                className="h-9 pl-9 pointer-coarse:h-11"
              />
            </div>
          ) : null}
          {loading ? (
            <RowList label="Meetings" columns={narrow ? [] : COLUMNS} flush busy>
              <ListRowSkeleton count={4} />
            </RowList>
          ) : list.error && list.recordings.length === 0 ? (
            <ErrorMessage
              align="center"
              title="Couldn't load meetings"
              details={[{ label: "Error", value: list.error.message }]}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void list.refresh()}
                  className="pointer-coarse:h-11"
                >
                  Try again
                </Button>
              }
            >
              Check your connection, then try again. Recordings in progress keep going either way.
            </ErrorMessage>
          ) : empty ? (
            query ? (
              <EmptyState
                variant="inline"
                title={`No meetings match “${query}”`}
                description="Only meeting titles are searched."
              />
            ) : (
              <EmptyState
                variant="page"
                icon={<AudioLinesIcon />}
                title="No meetings yet"
                description="Start a recording above. When you stop, Opengeni transcribes it and works out who said what."
                className="pt-8"
              />
            )
          ) : (
            <RowList label="Meetings" columns={narrow ? [] : COLUMNS} flush>
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
                          <span className={narrow ? "sr-only" : undefined}>Only me</span>
                        </MetaChip>
                      ) : undefined
                    }
                    status={
                      isLive ? (
                        <StatusBadge variant="dot" tone="danger" pulse>
                          Recording
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
                              ? `${formatDuration(recording.durationMilliseconds)} long`
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
                        Delete meeting
                      </DropdownMenuItem>
                    }
                    menuLabel={`More actions for ${recording.title}`}
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
                {list.loadingMore ? "Loading" : "Show older meetings"}
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
