import type { Recording } from "@opengeni/contracts";
import { useOpenGeniText } from "@opengeni/react/messages";
import {
  defaultMeetingTitle,
  formatClock,
  formatDuration,
  groupLiveTurns,
  meetingHereStatus,
  meetingPhase,
  meetingStatusLabel,
  tidyLiveText,
  tidyPartialText,
  useRecordingModels,
  useRecordings,
} from "@opengeni/react/recordings";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native";
import { Button, fontStyle, Icon, useNativeTimelineTheme, withAlpha } from "../timeline";
import {
  liveCostHint,
  meetingDateLabel,
  phoneLiveStatus,
  phoneRecorderErrorText,
  phoneUploadLine,
} from "./phone-text";
import { isCapturing, useMeetingRecorder, type MeetingRecorder } from "./recorder";

export type MeetingsListProps = {
  /** The SDK client. The `OpenGeniProvider`'s client otherwise. */
  client?: object;
  /** The workspace the meetings are in. The `OpenGeniProvider`'s workspace otherwise. */
  workspaceId?: string;
  /** Open one meeting, for example by pushing its screen. */
  onOpen: (recordingId: string) => void;
  /**
   * Only the meetings recorded with this id (a project, a customer), and new
   * ones start with it.
   */
  externalRef?: string | null;
  /** Offer the live transcript preview where the workspace has a live model. Default: true. */
  liveTranscript?: boolean;
  /** Whether the live preview starts switched on. Default: false. */
  liveTranscriptDefault?: boolean;
  /**
   * Shown instead of the recorder, for a host where recording is turned off.
   * The list of meetings still shows.
   */
  recordingOff?: ReactNode;
  /** Above the recorder, scrolled with the list. */
  header?: ReactNode;
  /**
   * The screen is in front. Pass your navigator's focus (`useIsFocused()`) so
   * the list refreshes when the person comes back to it.
   */
  focused?: boolean;
  /** Space below the list, such as the bottom safe-area inset. */
  bottomInset?: number;
};

/**
 * The meetings page at phone width: the recorder on top, then every meeting the
 * person can see, newest first. Reads the client and workspace from props or an
 * `OpenGeniProvider`, and needs a {@link MeetingRecorderProvider} above it to record.
 */
export function MeetingsList({
  client,
  workspaceId,
  onOpen,
  externalRef = null,
  liveTranscript = true,
  liveTranscriptDefault = false,
  recordingOff,
  header,
  focused,
  bottomInset = 0,
}: MeetingsListProps) {
  const msg = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const recorder = useMeetingRecorder();
  const scope = { ...(client ? { client } : {}), ...(workspaceId ? { workspaceId } : {}) };
  const list = useRecordings({ ...scope, ...(externalRef ? { externalRef } : {}) });
  // The live preview is offered only where the workspace has a live model.
  const models = useRecordingModels({ ...scope, enabled: liveTranscript && !recordingOff });
  const liveModel = models.liveModels.find((entry) => entry.available) ?? null;
  const refreshList = list.refresh;
  const [pulling, setPulling] = useState(false);

  useEffect(() => {
    if (focused) void refreshList();
  }, [focused, refreshList]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshList();
    });
    return () => subscription.remove();
  }, [refreshList]);
  // A recording that just finished uploading shows up (and starts transcribing) at once.
  const finishedCount = recorder?.finished.length ?? 0;
  useEffect(() => {
    if (finishedCount > 0) void refreshList();
  }, [finishedCount, refreshList]);
  const capturingId = isCapturing(recorder) ? recorder?.recordingId : null;
  // Refresh once the server has the new recording, so it shows in the list.
  const listedId = capturingId && recorder?.upload?.created ? capturingId : null;
  const capturingStarted = useRef<string | null>(null);
  useEffect(() => {
    if (listedId && capturingStarted.current !== listedId) {
      capturingStarted.current = listedId;
      void refreshList();
    }
  }, [listedId, refreshList]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.bg }}
      refreshControl={
        <RefreshControl
          refreshing={pulling}
          onRefresh={() => {
            setPulling(true);
            void list.refresh().finally(() => setPulling(false));
          }}
        />
      }
      contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: bottomInset + 32 }}
    >
      {header}
      {recordingOff ? (
        <View style={{ marginTop: 8 }}>{recordingOff}</View>
      ) : recorder ? (
        <RecorderCard
          recorder={recorder}
          externalRef={externalRef}
          liveTranscript={
            liveTranscript && liveModel
              ? { defaultOn: liveTranscriptDefault, usdPerHour: liveModel.usdPerHour }
              : null
          }
        />
      ) : null}
      <Text
        accessibilityRole="header"
        style={{
          ...fontStyle(theme, 600),
          fontSize: 12,
          color: c["fg-muted"],
          marginTop: 24,
          marginBottom: 4,
          paddingHorizontal: 4,
        }}
      >
        {msg("native.meetings.meetingsList.recent")}
      </Text>
      {list.loading && list.recordings.length === 0 ? (
        <ActivityIndicator style={{ marginTop: 24 }} color={c["fg-muted"]} />
      ) : list.error && list.recordings.length === 0 ? (
        <Text style={{ ...fontStyle(theme), fontSize: 14, color: c.danger, padding: 4 }}>
          {msg("native.meetings.meetingsList.meetingsCouldntLoadPullDown")}
        </Text>
      ) : list.recordings.length === 0 ? (
        <Text
          style={{
            ...fontStyle(theme),
            fontSize: 14,
            lineHeight: 20,
            color: c["fg-muted"],
            padding: 4,
          }}
        >
          {recordingOff
            ? msg("meetings.listPage.noMeetingsYet")
            : msg("native.meetings.meetingsList.noMeetingsYetRecordOne")}
        </Text>
      ) : (
        <View
          style={{
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c["surface-1"],
            overflow: "hidden",
          }}
        >
          {list.recordings.map((recording, index) => {
            // Recording here until Stop; after it, Transcribing.
            const here =
              recording.state === "capturing" ? meetingHereStatus(recorder, recording.id) : null;
            return (
              <MeetingRow
                key={recording.id}
                recording={recording}
                live={here === "recording" || here === "paused"}
                paused={here === "paused"}
                transcribingHere={here === "transcribing"}
                first={index === 0}
                onPress={() => onOpen(recording.id)}
              />
            );
          })}
        </View>
      )}
      {list.hasMore ? (
        <Button
          label={
            list.loadingMore
              ? msg("meetings.listPage.loading")
              : msg("meetings.listPage.showOlderMeetings")
          }
          variant="ghost"
          busy={list.loadingMore}
          onPress={() => void list.loadMore()}
          style={{ marginTop: 12, alignSelf: "center" }}
        />
      ) : null}
    </ScrollView>
  );
}

function MeetingRow(props: {
  recording: Recording;
  live: boolean;
  paused: boolean;
  /** Stopped on this phone with its last audio on its way: Transcribing, not In progress. */
  transcribingHere: boolean;
  first: boolean;
  onPress: () => void;
}) {
  const msg = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const { recording } = props;
  const status = props.live
    ? null
    : meetingStatusLabel(
        props.transcribingHere ? { kind: "transcribing", version: null } : meetingPhase(recording),
        msg,
      );
  const facts = [
    meetingDateLabel(msg, recording.startedAt),
    recording.durationMilliseconds ? formatDuration(recording.durationMilliseconds, msg) : null,
  ].filter(Boolean);
  const liveLabel = props.paused
    ? msg("meetings.recorderPanel.paused")
    : msg("meetings.recorderPanel.recording2");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        recording.title || msg("native.meetings.meetingsList.untitledMeeting"),
        ...facts,
        props.live ? liveLabel : status?.label,
      ]
        .filter(Boolean)
        .join(", ")}
      onPress={props.onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 60,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderTopWidth: props.first ? 0 : 1,
        borderTopColor: c.border,
        backgroundColor: pressed ? c.hover : "transparent",
      })}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text
          numberOfLines={2}
          style={{ ...fontStyle(theme, 500), fontSize: 15, lineHeight: 20, color: c.fg }}
        >
          {recording.title || msg("native.meetings.meetingsList.untitledMeeting")}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {recording.visibility === "private" ? (
            <Icon name="lock" size={11} color={c["fg-subtle"]} />
          ) : null}
          <Text
            numberOfLines={2}
            style={{ ...fontStyle(theme), fontSize: 13, color: c["fg-muted"], flexShrink: 1 }}
          >
            {facts.join(" · ")}
          </Text>
        </View>
      </View>
      {props.live ? (
        <StatusText label={liveLabel} color={props.paused ? c["fg-muted"] : c.danger} />
      ) : status ? (
        <StatusText
          label={status.label}
          color={status.tone === "danger" ? c.danger : c["fg-muted"]}
          spinning={status.tone === "progress"}
        />
      ) : null}
      <Icon name="chevron-right" size={14} color={c["fg-subtle"]} />
    </Pressable>
  );
}

function StatusText(props: { label: string; color: string; spinning?: boolean }) {
  const theme = useNativeTimelineTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      {props.spinning ? <ActivityIndicator size="small" color={props.color} /> : null}
      <Text style={{ ...fontStyle(theme, 500), fontSize: 12, color: props.color }}>
        {props.label}
      </Text>
    </View>
  );
}

function StopButton({ recorder, style }: { recorder: MeetingRecorder; style?: object }) {
  const msg = useOpenGeniText();
  const live = recorder.state === "recording" || recorder.state === "paused";
  const stop = () => {
    Alert.alert(
      msg("native.meetings.meetingsList.stopRecording"),
      msg("native.meetings.meetingsList.theMeetingIsUploadedAndTranscribed"),
      [
        { text: msg("native.meetings.meetingsList.keepRecording"), style: "cancel" },
        {
          text: msg("meetings.recorderPanel.stop"),
          style: "destructive",
          onPress: () => void recorder.stop(),
        },
      ],
    );
  };
  return (
    <Button
      label={msg("meetings.recorderPanel.stop")}
      icon="square"
      size="form"
      variant="destructive"
      disabled={!live}
      busy={recorder.state === "stopping"}
      onPress={stop}
      style={style}
    />
  );
}

/* Idle, one large Record button. Live, the clock, a level meter, Pause or
   Resume and Stop, and one line saying where the audio is. */
function RecorderCard({
  recorder,
  externalRef,
  liveTranscript,
}: {
  recorder: MeetingRecorder;
  externalRef: string | null;
  /** Offer the live preview, switched on or off to start with. */
  liveTranscript: { defaultOn: boolean; usdPerHour: number | null } | null;
}) {
  const msg = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const live = recorder.state === "recording" || recorder.state === "paused";
  const busy = recorder.state === "starting" || recorder.state === "stopping";
  const line = phoneUploadLine(msg, recorder);
  const error = recorder.error ? phoneRecorderErrorText(msg, recorder.error) : null;
  const silent = useSilentMicrophone(recorder, recorder.state === "recording");
  const [liveChoice, setLiveChoice] = useState<boolean | null>(null);
  const liveOn = liveTranscript ? (liveChoice ?? liveTranscript.defaultOn) : false;

  const start = () => {
    void recorder.start({
      title: defaultMeetingTitle(new Date(), msg),
      ...(externalRef ? { externalRef } : {}),
      ...(liveOn ? { liveTranscript: true } : {}),
    });
  };
  const stateLabel =
    recorder.state === "paused"
      ? msg("meetings.recorderPanel.paused")
      : recorder.state === "stopping"
        ? msg("meetings.recorderPanel.saving")
        : recorder.state === "starting"
          ? msg("native.meetings.meetingsList.starting")
          : msg("meetings.recorderPanel.recording2");

  return (
    <View
      style={{
        marginTop: 8,
        padding: 16,
        gap: 14,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: live ? withAlpha(c.danger, 0.35) : c.border,
        backgroundColor: c["surface-1"],
      }}
    >
      {!recorder.supported ? (
        <Text style={{ ...fontStyle(theme), fontSize: 14, lineHeight: 20, color: c["fg-muted"] }}>
          {msg("native.meetings.meetingsList.thisVersionOfTheAppCantRecord")}
        </Text>
      ) : live || busy ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <RecordingDot paused={recorder.state === "paused"} />
            <Text
              accessibilityRole="timer"
              accessibilityLabel={msg("native.meetings.meetingsList.recordedDuration", {
                duration: formatDuration(recorder.elapsedMilliseconds, msg),
              })}
              style={{
                ...fontStyle(theme, 600),
                fontSize: 34,
                lineHeight: 40,
                color: c.fg,
                fontVariant: ["tabular-nums"],
              }}
            >
              {formatClock(recorder.elapsedMilliseconds)}
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={{ ...fontStyle(theme, 500), fontSize: 13, color: c["fg-muted"] }}>
              {stateLabel}
            </Text>
          </View>
          <LevelMeter recorder={recorder} active={recorder.state === "recording"} />
          <LivePreview recorder={recorder} />
          <View style={{ flexDirection: "row", gap: 10 }}>
            {recorder.state === "paused" ? (
              <Button
                label={msg("meetings.recorderPanel.resume")}
                icon="play"
                size="form"
                onPress={() => recorder.resume()}
                style={{ flex: 1 }}
              />
            ) : (
              <Button
                label={msg("meetings.recorderPanel.pause")}
                icon="pause"
                size="form"
                disabled={!live}
                onPress={() => recorder.pause()}
                style={{ flex: 1 }}
              />
            )}
            <StopButton recorder={recorder} style={{ flex: 1 }} />
          </View>
        </>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={msg("native.meetings.meetingsList.startRecordingAMeeting")}
            onPress={start}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              minHeight: 56,
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderRadius: theme.radius.lg,
              backgroundColor: pressed ? withAlpha(c["danger-fill"], 0.85) : c["danger-fill"],
            })}
          >
            <Icon name="mic" size={20} color={c["danger-fg"]} />
            <Text
              style={{
                ...fontStyle(theme, 600),
                fontSize: 17,
                color: c["danger-fg"],
                flexShrink: 1,
                textAlign: "center",
              }}
            >
              {msg("native.meetings.meetingsList.recordAMeeting")}
            </Text>
          </Pressable>
          <Text style={{ ...fontStyle(theme), fontSize: 13, lineHeight: 18, color: c["fg-muted"] }}>
            {msg("native.meetings.meetingsList.recordsWithThisPhoneSMicrophone")}
          </Text>
          {liveTranscript ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ ...fontStyle(theme, 500), fontSize: 15, color: c.fg }}>
                  {msg("meetings.recorderPanel.liveTranscript")}
                </Text>
                <Text
                  style={{
                    ...fontStyle(theme),
                    fontSize: 13,
                    lineHeight: 18,
                    color: c["fg-muted"],
                  }}
                >
                  {liveOn
                    ? `${msg("native.meetings.meetingsList.showsWhatSSaid")} ${liveCostHint(msg, liveTranscript.usdPerHour)}`
                    : msg("native.meetings.meetingsList.showsWhatSSaid")}
                </Text>
              </View>
              <Switch
                accessibilityLabel={msg("meetings.recorderPanel.liveTranscript")}
                value={liveOn}
                onValueChange={setLiveChoice}
              />
            </View>
          ) : null}
        </>
      )}
      {error ? (
        <View style={{ gap: 4 }}>
          <Text style={{ ...fontStyle(theme, 600), fontSize: 14, color: c.danger }}>
            {error.title}
          </Text>
          <Text style={{ ...fontStyle(theme), fontSize: 13, lineHeight: 18, color: c["fg-muted"] }}>
            {error.body}
          </Text>
          {recorder.error?.code === "microphone_denied" ? (
            <Button
              label={msg("native.meetings.meetingsList.openSettings")}
              variant="secondary"
              onPress={() => void Linking.openSettings()}
              style={{ alignSelf: "flex-start", marginTop: 6 }}
            />
          ) : null}
        </View>
      ) : silent ? (
        <Text style={{ ...fontStyle(theme), fontSize: 13, lineHeight: 18, color: c.danger }}>
          {msg("native.meetings.meetingsList.noSoundIsReachingTheMicrophone")}
        </Text>
      ) : line && (live || busy || recorder.upload) ? (
        <Text style={{ ...fontStyle(theme), fontSize: 13, lineHeight: 18, color: c["fg-muted"] }}>
          {line}
        </Text>
      ) : null}
      {!live && !busy && recorder.recovered.length > 0 && !recorder.upload ? (
        <Text style={{ ...fontStyle(theme), fontSize: 13, lineHeight: 18, color: c["fg-muted"] }}>
          {msg("native.meetings.meetingsList.finishingTheUploadOfMeetingsRecordedEarlier", {
            count: recorder.recovered.length,
          })}
        </Text>
      ) : null}
    </View>
  );
}

function RecordingDot({ paused }: { paused: boolean }) {
  const theme = useNativeTimelineTheme();
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (paused) {
      opacity.setValue(0.35);
      return;
    }
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [paused, opacity]);
  return (
    <Animated.View
      accessibilityElementsHidden
      style={{
        width: 12,
        height: 12,
        borderRadius: 6,
        backgroundColor: theme.colors.danger,
        opacity,
      }}
    />
  );
}

/* What's being said while recording, newest at the bottom. A preview: the
   meeting's transcript, with speakers told apart, comes after Stop. */
function LivePreview({ recorder }: { recorder: MeetingRecorder }) {
  const msg = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const live = recorder.live;
  const turns = useMemo(
    () => groupLiveTurns((live ?? []).flatMap((track) => track.segments)),
    [live],
  );
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  // Follow the newest words unless the person scrolled up to reread.
  const following = useRef(true);
  const onContentSizeChange = useCallback(() => {
    if (following.current) scroll.current?.scrollToEnd({ animated: false });
  }, []);
  if (!live || live.length === 0) return null;
  const partial = live
    .map((track) => tidyPartialText(track.partial))
    .filter(Boolean)
    .join(" ");
  const textStyle = { ...fontStyle(theme), fontSize: 15, lineHeight: 21 };
  if (turns.length === 0 && live.every((track) => track.state === "unavailable")) {
    return (
      <Text style={{ ...fontStyle(theme), fontSize: 13, lineHeight: 18, color: c["fg-muted"] }}>
        {msg("meetings.recorderPanel.liveTextIsnTAvailable", { value: "" })}
      </Text>
    );
  }
  const status = phoneLiveStatus(msg, live, recorder.state === "paused");
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <Text style={{ ...fontStyle(theme, 600), fontSize: 12, color: c["fg-muted"], flex: 1 }}>
          {`${msg("meetings.liveTranscript.liveTranscript")} ${msg("meetings.liveTranscript.preview")}`}
        </Text>
        {status ? (
          <Text
            accessibilityLiveRegion="polite"
            style={{ ...fontStyle(theme), fontSize: 12, color: c["fg-muted"] }}
          >
            {status}
          </Text>
        ) : null}
      </View>
      <ScrollView
        ref={scroll}
        nestedScrollEnabled
        accessibilityLabel={msg("meetings.liveTranscript.liveTranscriptText")}
        style={{
          maxHeight: 220,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c["surface-2"],
        }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 10, gap: 10 }}
        scrollEventThrottle={100}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          following.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 24;
        }}
        onContentSizeChange={onContentSizeChange}
      >
        {turns.length === 0 && !partial ? (
          <Text style={{ ...textStyle, color: c["fg-muted"] }}>
            {recorder.state === "paused"
              ? msg("meetings.recorderPanel.pausedNothingIsHeardUntil")
              : msg("meetings.recorderPanel.listeningWhatSSaidShows")}
          </Text>
        ) : (
          turns.map((turn, index) => (
            <View key={turn.key} style={{ gap: 2 }}>
              <Text
                style={{
                  ...fontStyle(theme),
                  fontSize: 12,
                  color: c["fg-subtle"],
                  fontVariant: ["tabular-nums"],
                }}
              >
                {formatClock(turn.startMilliseconds)}
              </Text>
              <Text selectable style={{ ...textStyle, color: c.fg }}>
                {tidyLiveText(turn.texts)}
                {partial && index === turns.length - 1 ? (
                  <Text style={{ color: c["fg-muted"] }}> {partial}</Text>
                ) : null}
              </Text>
            </View>
          ))
        )}
        {partial && turns.length === 0 ? (
          <Text style={{ ...textStyle, color: c["fg-muted"] }}>{partial}</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

/* The microphone's level, read a few times a second; a flat bar while paused. */
// Input levels are RMS x 4. Anything a real room picks up stays well above this
// (about -78 dBFS); a muted, blocked or broken microphone delivers silence.
const SILENT_LEVEL = 0.0005;
const SILENT_AFTER_MS = 10_000;

/** True once a running recording has heard nothing at all for a while. */
function useSilentMicrophone(recorder: MeetingRecorder, active: boolean): boolean {
  const [silent, setSilent] = useState(false);
  const levels = recorder.levels;
  useEffect(() => {
    if (!active) {
      setSilent(false);
      return;
    }
    let lastSound = Date.now();
    const timer = setInterval(() => {
      if ((levels()[0] ?? 0) > SILENT_LEVEL) lastSound = Date.now();
      setSilent(Date.now() - lastSound > SILENT_AFTER_MS);
    }, 500);
    return () => clearInterval(timer);
  }, [active, levels]);
  return silent;
}

function LevelMeter({ recorder, active }: { recorder: MeetingRecorder; active: boolean }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const width = useRef(new Animated.Value(0)).current;
  const levels = recorder.levels;
  useEffect(() => {
    if (!active) {
      width.setValue(0);
      return;
    }
    const timer = setInterval(() => {
      const level = Math.min(1, Math.max(0, levels()[0] ?? 0));
      Animated.timing(width, {
        toValue: level,
        duration: 90,
        useNativeDriver: false,
      }).start();
    }, 100);
    return () => clearInterval(timer);
  }, [active, levels, width]);
  return (
    <View
      accessibilityElementsHidden
      style={{
        height: 6,
        borderRadius: 3,
        backgroundColor: c["surface-3"],
        overflow: "hidden",
      }}
    >
      <Animated.View
        style={{
          height: 6,
          borderRadius: 3,
          backgroundColor: c.danger,
          width: width.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
        }}
      />
    </View>
  );
}
