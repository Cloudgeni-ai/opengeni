import type { Recording } from "@opengeni/contracts";
import {
  defaultMeetingTitle,
  formatClock,
  formatDuration,
  meetingPhase,
  meetingStatusLabel,
  useRecordings,
} from "@opengeni/react/recordings";
import {
  Button,
  fontStyle,
  Icon,
  useNativeTimelineTheme,
  withAlpha,
} from "@opengeni/react-native/timeline";
import * as Haptics from "expo-haptics";
import { Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAccount } from "@/account";
import {
  isCapturing,
  meetingDateLabel,
  phoneRecorderErrorText,
  phoneUploadLine,
  useMeetingRecorder,
  WorkspaceGate,
  type MeetingRecorder,
} from "@/meetings";
import { AppThemeProvider } from "@/theme";

export default function MeetingsScreen() {
  return (
    <AppThemeProvider>
      <WorkspaceGate title="Meetings">
        {(workspaceId) => <Meetings workspaceId={workspaceId} />}
      </WorkspaceGate>
    </AppThemeProvider>
  );
}

/* The web Meetings page at phone width: the recorder on top, then every
   meeting the person can see, newest first. */
function Meetings({ workspaceId }: { workspaceId: string }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const { client } = useAccount();
  const recorder = useMeetingRecorder();
  const list = useRecordings({ client, workspaceId });
  const refreshList = list.refresh;
  const [pulling, setPulling] = useState(false);

  useFocusEffect(
    useCallback(() => {
      void refreshList();
    }, [refreshList]),
  );
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
    <>
      <Stack.Screen
        options={{
          title: "Meetings",
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.fg,
          headerShadowVisible: false,
        }}
      />
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
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 32 }}
      >
        {recorder ? <RecorderCard recorder={recorder} /> : null}
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
          Recent
        </Text>
        {list.loading && list.recordings.length === 0 ? (
          <ActivityIndicator style={{ marginTop: 24 }} color={c["fg-muted"]} />
        ) : list.error && list.recordings.length === 0 ? (
          <Text style={{ ...fontStyle(theme), fontSize: 14, color: c.danger, padding: 4 }}>
            Meetings couldn't load. Pull down to try again.
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
            No meetings yet. Record one above, here or on the web, and its transcript shows up here.
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
            {list.recordings.map((recording, index) => (
              <MeetingRow
                key={recording.id}
                recording={recording}
                live={recording.id === capturingId}
                first={index === 0}
                onPress={() => router.push(`/meeting/${recording.id}`)}
              />
            ))}
          </View>
        )}
        {list.hasMore ? (
          <Button
            label={list.loadingMore ? "Loading…" : "Show older meetings"}
            variant="ghost"
            busy={list.loadingMore}
            onPress={() => void list.loadMore()}
            style={{ marginTop: 12, alignSelf: "center" }}
          />
        ) : null}
      </ScrollView>
    </>
  );
}

function MeetingRow(props: {
  recording: Recording;
  live: boolean;
  first: boolean;
  onPress: () => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const { recording } = props;
  const status = props.live ? null : meetingStatusLabel(meetingPhase(recording));
  const facts = [
    meetingDateLabel(recording.startedAt),
    recording.durationMilliseconds ? formatDuration(recording.durationMilliseconds) : null,
  ].filter(Boolean);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[recording.title, ...facts, props.live ? "Recording now" : status?.label]
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
          numberOfLines={1}
          style={{ ...fontStyle(theme, 500), fontSize: 15, lineHeight: 20, color: c.fg }}
        >
          {recording.title || "Untitled meeting"}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {recording.visibility === "private" ? (
            <Icon name="lock" size={11} color={c["fg-subtle"]} />
          ) : null}
          <Text
            numberOfLines={1}
            style={{ ...fontStyle(theme), fontSize: 13, color: c["fg-muted"], flexShrink: 1 }}
          >
            {facts.join(" · ")}
          </Text>
        </View>
      </View>
      {props.live ? (
        <StatusText label="Recording" color={c.danger} />
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

/* Idle, one large Record button. Live, the clock, a level meter, Pause or
   Resume and Stop, and one line saying where the audio is. */
function RecorderCard({ recorder }: { recorder: MeetingRecorder }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const live = recorder.state === "recording" || recorder.state === "paused";
  const busy = recorder.state === "starting" || recorder.state === "stopping";
  const line = phoneUploadLine(recorder);
  const error = recorder.error ? phoneRecorderErrorText(recorder.error) : null;

  const start = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void recorder.start({ title: defaultMeetingTitle(new Date()) });
  };
  const stop = () => {
    Alert.alert("Stop recording?", "The meeting uploads and its transcript starts.", [
      { text: "Keep recording", style: "cancel" },
      {
        text: "Stop",
        style: "destructive",
        onPress: () => {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          void recorder.stop();
        },
      },
    ]);
  };

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
          This version of the app can't record. Update it to record meetings on this phone.
        </Text>
      ) : live || busy ? (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <RecordingDot paused={recorder.state === "paused"} />
            <Text
              accessibilityRole="timer"
              accessibilityLabel={`Recorded ${formatDuration(recorder.elapsedMilliseconds)}`}
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
              {recorder.state === "paused"
                ? "Paused"
                : recorder.state === "stopping"
                  ? "Saving…"
                  : recorder.state === "starting"
                    ? "Starting…"
                    : "Recording"}
            </Text>
          </View>
          <LevelMeter recorder={recorder} active={recorder.state === "recording"} />
          <View style={{ flexDirection: "row", gap: 10 }}>
            {recorder.state === "paused" ? (
              <Button
                label="Resume"
                icon="play"
                size="form"
                onPress={() => recorder.resume()}
                style={{ flex: 1 }}
              />
            ) : (
              <Button
                label="Pause"
                icon="pause"
                size="form"
                disabled={!live}
                onPress={() => recorder.pause()}
                style={{ flex: 1 }}
              />
            )}
            <Button
              label="Stop"
              icon="square"
              size="form"
              variant="destructive"
              disabled={!live}
              busy={recorder.state === "stopping"}
              onPress={stop}
              style={{ flex: 1 }}
            />
          </View>
        </>
      ) : (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start recording a meeting"
            onPress={start}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              height: 56,
              borderRadius: theme.radius.lg,
              backgroundColor: pressed ? withAlpha(c.danger, 0.85) : c.danger,
            })}
          >
            <Icon name="mic" size={20} color={c["danger-fg"]} />
            <Text style={{ ...fontStyle(theme, 600), fontSize: 17, color: c["danger-fg"] }}>
              Record a meeting
            </Text>
          </Pressable>
          <Text style={{ ...fontStyle(theme), fontSize: 13, lineHeight: 18, color: c["fg-muted"] }}>
            Records this phone's microphone, also with the screen locked. You get a transcript with
            who said what when you stop.
          </Text>
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
              label="Open Settings"
              variant="secondary"
              onPress={() => void Linking.openSettings()}
              style={{ alignSelf: "flex-start", marginTop: 6 }}
            />
          ) : null}
        </View>
      ) : line && (live || busy || recorder.upload) ? (
        <Text style={{ ...fontStyle(theme), fontSize: 13, lineHeight: 18, color: c["fg-muted"] }}>
          {line}
        </Text>
      ) : null}
      {!live && !busy && recorder.recovered.length > 0 && !recorder.upload ? (
        <Text style={{ ...fontStyle(theme), fontSize: 13, lineHeight: 18, color: c["fg-muted"] }}>
          {recorder.recovered.length === 1
            ? "Finishing the upload of a meeting recorded earlier."
            : `Finishing the upload of ${recorder.recovered.length} meetings recorded earlier.`}
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

/* The microphone's level, read a few times a second; a flat bar while paused. */
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
