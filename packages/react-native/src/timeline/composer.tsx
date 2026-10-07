import {
  defaultChatComposerMessages,
  type ChatComposerMessages,
} from "@opengeni/react/composer-messages";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { useEffect, useState, type ComponentRef, type ReactNode, type Ref } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type ViewStyle,
} from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { Button } from "./controls";
import { Icon, type NativeIconName } from "./icon";
import { withAlpha } from "./primitives";
import { fontStyle, useNativeTimelineTheme } from "./theme";
import type { NativeVoiceInput } from "../voice-input";

/* ----------------------------------------------------------------------------
   The session composer, designed for each platform rather than copied from
   the web card. It keeps the web composer's behaviour and copy (the shared
   message catalog): one field, leading actions, the model pill, and a single
   trailing action that sends, pauses a running workstream, or resumes it.

   iOS 26+: a floating Liquid Glass surface the conversation scrolls under.
   Older iOS or Reduce Transparency: the same shape on a solid raised surface.
   Android: a Material 3 filled container (no glass, no border).
   -------------------------------------------------------------------------- */

export interface SessionComposerProps {
  value: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  canSend: boolean;
  sending?: boolean | undefined;
  placeholder?: string | undefined;
  /** Run state drives the trailing action: pause while running, resume when paused. */
  running?: boolean | undefined;
  paused?: boolean | undefined;
  onPause?: (() => void) | undefined;
  onResume?: (() => void) | undefined;
  pauseBusy?: boolean | undefined;
  /** Leading toolbar content; defaults to an attach button when `onAttach` is set. */
  renderLeading?: (() => ReactNode) | undefined;
  onAttach?: (() => void) | undefined;
  /** Content between leading actions and the trailing action (model/options pill). */
  options?: ReactNode;
  /** Rendered inside the surface above the field (attachment chips, annotations). */
  header?: ReactNode;
  /** Rendered above the surface (queue, approvals, status dock). */
  above?: ReactNode;
  bottomInset?: number | undefined;
  /** Distance from the composer's container bottom to the window bottom (tab bars). */
  keyboardBottomOffset?: number | undefined;
  autoFocus?: boolean | undefined;
  /** Horizontal page inset around the surface (default 12). */
  inset?: number | undefined;
  /** Lift above the keyboard (bottom-docked composer). Off for an inline card. */
  liftWithKeyboard?: boolean | undefined;
  /**
   * Float over the conversation (absolute, transparent around the surface) so
   * content scrolls beneath it. The host reads the occupied height from
   * `onHeightChange` to inset its scroll content.
   */
  floating?: boolean | undefined;
  onHeightChange?: ((height: number) => void) | undefined;
  /** Rendered inside the surface under the header (draft conflict, notices). */
  below?: ReactNode;
  /** The message field, for hosts that focus it (queue Edit, replies). */
  inputRef?: Ref<ComponentRef<typeof TextInput>> | undefined;
  /** The shared composer catalog; hosts translate by overriding entries. */
  messages?: Partial<ChatComposerMessages> | undefined;
  /** Called when the trailing action fires (host haptics). */
  onActionFeedback?: (() => void) | undefined;
  /** Dictation: a mic beside the leading actions, and the recording strip while it runs. */
  voice?: NativeVoiceInput | undefined;
}

/** Whether to draw Liquid Glass: iOS 26+, the native module present, transparency allowed. */
export function useLiquidGlass(): boolean {
  const [reduceTransparency, setReduceTransparency] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    void AccessibilityInfo.isReduceTransparencyEnabled().then(setReduceTransparency);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      setReduceTransparency,
    );
    return () => subscription.remove();
  }, []);
  if (Platform.OS !== "ios" || reduceTransparency) return false;
  try {
    return isLiquidGlassAvailable();
  } catch {
    return false;
  }
}

/**
 * A floating surface for composer-adjacent chrome: glass on iOS 26, a solid
 * raised surface elsewhere.
 */
export function ComposerSurface({
  children,
  radius,
  style,
}: {
  children: ReactNode;
  radius: number;
  style?: ViewStyle | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const glass = useLiquidGlass();
  if (glass) {
    // Hosts must keep this surface's ancestors free of animated opacity: iOS
    // does not render glass that was mounted beneath a fading parent.
    // The glass keeps the appearance it was created with, so a change of
    // light or dark mounts a fresh one.
    return (
      <GlassView
        key={theme.scheme}
        glassEffectStyle="regular"
        colorScheme={theme.scheme}
        style={[{ borderRadius: radius }, style]}
      >
        {children}
      </GlassView>
    );
  }
  const android = Platform.OS === "android";
  return (
    <View
      style={[
        {
          borderRadius: radius,
          // Material 3 surfaceContainerHigh: a filled tonal surface, no outline.
          backgroundColor: android ? c["surface-2"] : c["surface-1"],
          ...(android
            ? null
            : {
                borderWidth: 0.5,
                borderColor: c.border,
                shadowColor: "#000",
                shadowOpacity: theme.scheme === "dark" ? 0 : 0.08,
                shadowRadius: 12,
                shadowOffset: { width: 0, height: 4 },
              }),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function SessionComposer(props: SessionComposerProps) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const ios = Platform.OS === "ios";
  const [height, setHeight] = useState(22);
  const empty = !props.value;
  useEffect(() => {
    if (empty) setHeight(22);
  }, [empty]);
  // Track the keyboard directly: React Native's KeyboardAvoidingView mis-measures
  // inside modals and overlays; the animated keyboard height does not.
  const keyboard = useAnimatedKeyboard();
  const floating = props.floating ?? false;
  // Only Liquid Glass lets the conversation scroll visibly beneath the composer;
  // a solid surface (Android, older iOS) sits on an opaque band down to the
  // screen edge, or text would peek out under the card and the gesture handle.
  const glass = useLiquidGlass();
  const seeThrough = floating && glass;
  // Floating: iOS tucks the glass toward the home indicator like system bars;
  // Android keeps clear of the gesture handle.
  const restingBottom = floating
    ? ios
      ? Math.max(10, (props.bottomInset ?? 0) - 4)
      : (props.bottomInset ?? 0) + 8
    : Math.max(16, (props.bottomInset ?? 0) + 4);
  const offset = props.keyboardBottomOffset ?? 0;
  const liftWithKeyboard = props.liftWithKeyboard ?? true;
  const lift = useAnimatedStyle(() => {
    if (!liftWithKeyboard) return { paddingBottom: restingBottom };
    const lifted = keyboard.height.value - offset;
    return { paddingBottom: lifted > 0 ? lifted + 8 : restingBottom };
  });
  const messages = { ...defaultChatComposerMessages, ...props.messages };
  const fieldSize = ios ? 17 : 16;
  const compact = !props.options;
  const voice = props.voice?.available ? props.voice : undefined;
  const capturing =
    voice !== undefined &&
    (voice.status === "recording" ||
      voice.status === "requesting-permission" ||
      voice.status === "transcribing");
  const attach = props.renderLeading ? (
    props.renderLeading()
  ) : props.onAttach ? (
    <ToolbarButton icon="plus" accessibilityLabel={messages.attachFiles} onPress={props.onAttach} />
  ) : null;
  const leading =
    attach || voice ? (
      <>
        {attach}
        {voice ? (
          <ToolbarButton icon="mic" accessibilityLabel="Dictate" onPress={voice.start} />
        ) : null}
      </>
    ) : null;
  const field = (inline: boolean) => (
    <TextInput
      ref={props.inputRef}
      accessibilityLabel={messages.inputLabel}
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={
        props.placeholder ?? (props.paused ? messages.pausedPlaceholder : "Send a follow-up...")
      }
      placeholderTextColor={c["fg-subtle"]}
      multiline
      autoFocus={props.autoFocus}
      selectionColor={c.accent}
      onContentSizeChange={(event) =>
        setHeight(Math.min(150, Math.max(22, event.nativeEvent.contentSize.height)))
      }
      style={{
        ...fontStyle(theme),
        fontSize: fieldSize,
        lineHeight: 22,
        color: c.fg,
        ...(inline
          ? { paddingTop: 7, paddingBottom: 7, paddingHorizontal: 6, minHeight: 36 }
          : { paddingTop: 14, paddingBottom: 2, paddingHorizontal: 16, minHeight: 40 }),
        // The inline field sizes itself; the stacked one tracks its content.
        // (iOS never shrinks a self-sized multiline field, so an empty one is pinned.)
        // A cleared field (after Send) returns to one line: iOS does not report
        // the smaller content size, so the last height would otherwise stick.
        height: ios
          ? inline
            ? props.value
              ? undefined
              : 36
            : (props.value ? height : 22) + 16
          : undefined,
        maxHeight: 166,
        textAlignVertical: inline ? "center" : "top",
      }}
    />
  );
  return (
    <Animated.View
      pointerEvents={floating ? "box-none" : "auto"}
      onLayout={(event) => props.onHeightChange?.(event.nativeEvent.layout.height)}
      style={[
        {
          paddingHorizontal: props.inset ?? 12,
          paddingTop: 6,
          gap: 8,
          backgroundColor: seeThrough ? "transparent" : c.bg,
        },
        floating ? { position: "absolute", left: 0, right: 0, bottom: 0 } : null,
        lift,
      ]}
    >
      {props.above ? <View pointerEvents="box-none">{props.above}</View> : null}
      <ComposerSurface radius={compact ? 22 : 24}>
        {props.header}
        {props.below}
        {voice?.hasSavedRecording && voice.status === "error" ? (
          <SavedRecordingStrip voice={voice} />
        ) : voice?.status === "error" && voice.error ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${voice.error} Dismiss`}
            onPress={voice.clearError}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 16,
              paddingTop: 10,
            }}
          >
            <Icon name="circle-alert" size={14} color={c["status-failed"]} />
            <Text
              style={{
                ...fontStyle(theme),
                flex: 1,
                fontSize: 13,
                lineHeight: 18,
                color: c["status-failed"],
              }}
            >
              {voice.error}
            </Text>
            <Icon name="x" size={14} color={c["fg-subtle"]} />
          </Pressable>
        ) : null}
        {capturing && voice ? (
          <VoiceStrip voice={voice} />
        ) : compact ? (
          // No options to show: one row, as native messaging apps lay it out.
          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-end",
              paddingHorizontal: 5,
              paddingVertical: 5,
              gap: 2,
            }}
          >
            {leading}
            <View style={{ flex: 1, minWidth: 0 }}>{field(true)}</View>
            <View style={{ paddingBottom: 0 }}>
              <TrailingAction {...props} messages={messages} />
            </View>
          </View>
        ) : (
          <>
            {field(false)}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                paddingLeft: 6,
                paddingRight: 8,
                paddingBottom: 8,
                minHeight: 44,
                gap: 2,
              }}
            >
              {leading}
              <View style={{ flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0 }}>
                {props.options}
              </View>
              <TrailingAction {...props} messages={messages} />
            </View>
          </>
        )}
      </ComposerSurface>
    </Animated.View>
  );
}

/** A quiet round toolbar button (the web composer's leading actions). */
export function ToolbarButton({
  icon,
  accessibilityLabel,
  onPress,
}: {
  icon: NativeIconName;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const theme = useNativeTimelineTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: pressed ? theme.colors.hover : "transparent",
      })}
    >
      <Icon name={icon} size={20} color={theme.colors["fg-muted"]} />
    </Pressable>
  );
}

const LEVEL_BARS = 28;

function formatDictationTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * A recording whose text could not be fetched yet. It stays on the device:
 * Retry sends the same audio again; Discard is the only way to drop it.
 */
function SavedRecordingStrip({ voice }: { voice: NativeVoiceInput }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View style={{ gap: 6, paddingHorizontal: 16, paddingTop: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <Icon name="audio-lines" size={14} color={c["status-waiting"]} />
        <Text
          accessibilityLiveRegion="polite"
          style={{ ...fontStyle(theme), flex: 1, fontSize: 13, lineHeight: 18, color: c.fg }}
        >
          {voice.error ?? "Your recording is saved."}
        </Text>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 6 }}>
        <Button label="Discard" variant="ghost" onPress={voice.cancel} />
        <Button label="Retry" variant="primary" onPress={voice.retry} />
      </View>
    </View>
  );
}

/**
 * Dictation in progress, in place of the field: cancel, a live level meter with
 * the elapsed time, and stop (which transcribes into the draft).
 */
function VoiceStrip({ voice }: { voice: NativeVoiceInput }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [levels, setLevels] = useState<number[]>(() => Array<number>(LEVEL_BARS).fill(0));
  const recording = voice.status === "recording";
  const transcribing = voice.status === "transcribing";
  useEffect(() => {
    if (!recording) return;
    setLevels((current) => [...current.slice(1), voice.level ?? 0.15]);
  }, [recording, voice.durationSeconds, voice.level]);
  const remaining =
    voice.maxDurationSeconds !== null && voice.maxDurationSeconds - voice.durationSeconds <= 10
      ? ` · ${Math.max(0, Math.ceil(voice.maxDurationSeconds - voice.durationSeconds))}s left`
      : "";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 6,
        paddingVertical: 6,
        minHeight: 56,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel dictation"
        onPress={voice.cancel}
        disabled={transcribing}
        hitSlop={4}
        style={({ pressed }) => ({
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: pressed ? c.hover : "transparent",
          opacity: transcribing ? 0.4 : 1,
        })}
      >
        <Icon name="x" size={18} color={c["fg-muted"]} />
      </Pressable>
      <View
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={
          transcribing ? "Transcribing" : `Recording, ${formatDictationTime(voice.durationSeconds)}`
        }
        style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10, minWidth: 0 }}
      >
        {transcribing ? (
          <>
            <ActivityIndicator size="small" color={c["fg-muted"]} />
            <Text style={{ ...fontStyle(theme), fontSize: 15, color: c["fg-muted"] }}>
              Transcribing…
            </Text>
          </>
        ) : (
          <>
            <View
              style={{
                flex: 1,
                height: 28,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                overflow: "hidden",
              }}
            >
              {levels.map((value, index) => (
                <View
                  // Fixed slots: the meter scrolls by shifting values, not keys.
                  // oxlint-disable-next-line react/no-array-index-key
                  key={index}
                  style={{
                    width: 3,
                    borderRadius: 1.5,
                    height: 4 + Math.round(value * 24),
                    backgroundColor: index === LEVEL_BARS - 1 ? c.fg : c["fg-subtle"],
                  }}
                />
              ))}
            </View>
            <Text
              style={{
                ...fontStyle(theme, 500),
                fontSize: 14,
                color: c["fg-muted"],
                fontVariant: ["tabular-nums"],
              }}
            >
              {formatDictationTime(voice.durationSeconds)}
              {remaining}
            </Text>
          </>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Stop and transcribe"
        onPress={voice.stop}
        disabled={!recording}
        hitSlop={6}
        style={({ pressed }) => ({
          width: 34,
          height: 34,
          borderRadius: 17,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: recording ? c.accent : withAlpha(c.fg, 0.08),
          opacity: pressed ? 0.8 : 1,
          transform: [{ scale: pressed ? 0.94 : 1 }],
        })}
      >
        <Icon
          name="check"
          size={18}
          strokeWidth={2.5}
          color={recording ? c["accent-fg"] : c["fg-subtle"]}
        />
      </Pressable>
    </View>
  );
}

/**
 * One trailing control, as native chat apps do: send when there is something
 * to send (a message to a running agent joins the queue), otherwise pause a
 * running workstream or resume a paused one; an idle empty composer shows a
 * quiet, disabled send.
 */
function TrailingAction(props: SessionComposerProps & { messages: ChatComposerMessages }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const hasText = props.value.trim().length > 0;
  const mode: "send" | "pause" | "resume" | "idle" =
    hasText || props.canSend
      ? "send"
      : props.paused && props.onResume
        ? "resume"
        : props.running && props.onPause
          ? "pause"
          : "idle";
  const active = mode !== "idle";
  const busy = mode === "send" ? props.sending : mode === "idle" ? false : props.pauseBusy;
  const disabled = mode === "send" ? !props.canSend : !active;
  // A disabled send (text typed, but the host cannot send yet) looks disabled too.
  const lit = active && !disabled;
  const icon: NativeIconName = mode === "pause" ? "pause" : mode === "resume" ? "play" : "arrow-up";
  const label =
    mode === "pause"
      ? props.messages.pauseAriaLabel
      : mode === "resume"
        ? props.messages.resumeThisWorkstream
        : props.messages.sendMessageAriaLabel;
  const fg = lit ? c["accent-fg"] : c["fg-subtle"];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: Boolean(busy) }}
      disabled={disabled || busy}
      hitSlop={6}
      onPress={() => {
        props.onActionFeedback?.();
        if (mode === "send") props.onSend();
        else if (mode === "pause") props.onPause?.();
        else if (mode === "resume") props.onResume?.();
      }}
      style={({ pressed }) => ({
        width: 34,
        height: 34,
        borderRadius: 17,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: lit ? c.accent : withAlpha(c.fg, 0.08),
        opacity: pressed ? 0.8 : 1,
        transform: [{ scale: pressed ? 0.94 : 1 }],
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <Icon
          name={icon}
          size={icon === "arrow-up" ? 18 : 14}
          strokeWidth={icon === "arrow-up" ? 2.5 : 2}
          color={fg}
          fill={icon === "arrow-up" ? undefined : fg}
        />
      )}
    </Pressable>
  );
}

/**
 * The web model pill ("6 Luna High ⌄"): a quiet toolbar chip that opens host
 * options. As on web, the muted detail (reasoning effort) gives way first, so a
 * long name never pushes it into a clipped "Ext…".
 */
export function ComposerPill({
  label,
  detail,
  onPress,
  leading,
  fast = false,
}: {
  label: string;
  /** Secondary text after the label (the reasoning effort); truncates before the label. */
  detail?: string | null | undefined;
  /** Fast latency is on: a filled bolt after the name, as on the web pill. */
  fast?: boolean | undefined;
  onPress?: (() => void) | undefined;
  /** Shown before the label (the web picker's maker mark). */
  leading?: ReactNode;
}) {
  const theme = useNativeTimelineTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[label, detail, fast ? "Fast" : null].filter(Boolean).join(", ")}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        flexShrink: 1,
        maxWidth: 260,
        minHeight: 44,
        paddingHorizontal: 8,
        borderRadius: 999,
        backgroundColor: pressed ? theme.colors["surface-2"] : "transparent",
      })}
    >
      {leading}
      <Text
        numberOfLines={1}
        style={{
          ...fontStyle(theme, 500),
          fontSize: theme.size.sm,
          color: theme.colors.fg,
          flexShrink: 1,
        }}
      >
        {label}
      </Text>
      {detail ? (
        <Text
          numberOfLines={1}
          style={{
            ...fontStyle(theme, 500),
            fontSize: theme.size.sm,
            color: theme.colors["fg-muted"],
            flexShrink: 9999,
          }}
        >
          {detail}
        </Text>
      ) : null}
      {fast ? <Icon name="zap" size={13} color={theme.colors.fg} fill={theme.colors.fg} /> : null}
      <Icon name="chevron-down" size={12} color={theme.colors["fg-muted"]} />
    </Pressable>
  );
}
