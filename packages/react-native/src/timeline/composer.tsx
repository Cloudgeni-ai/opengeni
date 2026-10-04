import {
  defaultChatComposerMessages,
  type ChatComposerMessages,
} from "@opengeni/react/composer-messages";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { useEffect, useState, type ReactNode, type Ref } from "react";
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
import { Icon, type NativeIconName } from "./icon";
import { withAlpha } from "./primitives";
import { fontStyle, useNativeTimelineTheme } from "./theme";

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
  inputRef?: Ref<TextInput> | undefined;
  /** The shared composer catalog; hosts translate by overriding entries. */
  messages?: Partial<ChatComposerMessages> | undefined;
  /** Called when the trailing action fires (host haptics). */
  onActionFeedback?: (() => void) | undefined;
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
    return (
      <GlassView
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
  // Track the keyboard directly: React Native's KeyboardAvoidingView mis-measures
  // inside modals and overlays; the animated keyboard height does not.
  const keyboard = useAnimatedKeyboard();
  const floating = props.floating ?? false;
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
  const leading = props.renderLeading ? (
    props.renderLeading()
  ) : props.onAttach ? (
    <ToolbarButton icon="plus" accessibilityLabel={messages.attachFiles} onPress={props.onAttach} />
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
        height: ios ? (inline ? (props.value ? undefined : 36) : height + 16) : undefined,
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
          backgroundColor: floating ? "transparent" : c.bg,
        },
        floating ? { position: "absolute", left: 0, right: 0, bottom: 0 } : null,
        lift,
      ]}
    >
      {props.above ? <View pointerEvents="box-none">{props.above}</View> : null}
      <ComposerSurface radius={compact ? 22 : 24}>
        {props.header}
        {props.below}
        {compact ? (
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
  const icon: NativeIconName = mode === "pause" ? "pause" : mode === "resume" ? "play" : "arrow-up";
  const label =
    mode === "pause"
      ? props.messages.pauseAriaLabel
      : mode === "resume"
        ? props.messages.resumeThisWorkstream
        : props.messages.sendMessageAriaLabel;
  const fg = active ? c["accent-fg"] : c["fg-subtle"];
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
        backgroundColor: active ? c.accent : withAlpha(c.fg, 0.08),
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

/** The web model pill ("6 Luna ⌄"): a quiet toolbar chip that opens host options. */
export function ComposerPill({
  label,
  onPress,
  leading,
}: {
  label: string;
  onPress?: (() => void) | undefined;
  /** Shown before the label (the web picker's maker mark). */
  leading?: ReactNode;
}) {
  const theme = useNativeTimelineTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        flexShrink: 1,
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
      <Icon name="chevron-down" size={12} color={theme.colors["fg-muted"]} />
    </Pressable>
  );
}
