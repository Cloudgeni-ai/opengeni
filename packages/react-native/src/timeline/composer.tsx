import { useState, type ReactNode } from "react";
import { Platform, Text, TextInput, View } from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { IconButton } from "./controls";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   The web session composer at phone width: a bordered surface card with the
   message field on top and a 44pt toolbar below — leading actions (attach,
   dictate, model) on the left, pause and send on the right. Hosts fill the
   toolbar slots (a product adds its own actions/options) without forking.
   -------------------------------------------------------------------------- */

export interface SessionComposerProps {
  value: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  canSend: boolean;
  sending?: boolean | undefined;
  placeholder?: string | undefined;
  /** Run state drives the pause control (web: "Pause this workstream"). */
  running?: boolean | undefined;
  paused?: boolean | undefined;
  onPause?: (() => void) | undefined;
  onResume?: (() => void) | undefined;
  pauseBusy?: boolean | undefined;
  /** Leading toolbar content; defaults to an attach button when `onAttach` is set. */
  renderLeading?: (() => ReactNode) | undefined;
  onAttach?: (() => void) | undefined;
  /** Content between leading actions and the right-hand controls (model/options pill). */
  options?: ReactNode;
  /** Rendered above the field inside the card (attachment chips, annotations). */
  header?: ReactNode;
  /** Rendered above the card (queue, approvals, status dock). */
  above?: ReactNode;
  bottomInset?: number | undefined;
  /** Distance from the composer's container bottom to the window bottom (tab bars). */
  keyboardBottomOffset?: number | undefined;
  autoFocus?: boolean | undefined;
  /** Horizontal page inset around the card (default 16). */
  inset?: number | undefined;
  /** Lift above the keyboard (bottom-docked composer). Off for an inline card. */
  liftWithKeyboard?: boolean | undefined;
}

export function SessionComposer(props: SessionComposerProps) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const [height, setHeight] = useState(24);
  // Track the keyboard directly: React Native's KeyboardAvoidingView mis-measures
  // inside modals and overlays; the animated keyboard height does not.
  const keyboard = useAnimatedKeyboard();
  const restingBottom = Math.max(16, (props.bottomInset ?? 0) + 4);
  const offset = props.keyboardBottomOffset ?? 0;
  const liftWithKeyboard = props.liftWithKeyboard ?? true;
  const lift = useAnimatedStyle(() => {
    if (!liftWithKeyboard) return { paddingBottom: restingBottom };
    const lifted = keyboard.height.value - offset;
    return { paddingBottom: lifted > 0 ? lifted + 8 : restingBottom };
  });
  // Web shows the workstream control whenever the host can pause or resume.
  const showPause = Boolean(props.paused ? props.onResume : props.onPause);
  return (
    <Animated.View
      style={[{ paddingHorizontal: props.inset ?? 16, paddingTop: 4, backgroundColor: c.bg }, lift]}
    >
      {props.above}
      <View
        style={{
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c["surface-1"],
          // Web shadow-og-sm: 0 1px 2px rgb(0 0 0 / 0.07).
          shadowColor: "#000",
          shadowOpacity: 0.07,
          shadowRadius: 2,
          shadowOffset: { width: 0, height: 1 },
          elevation: 1,
        }}
      >
        {props.header}
        <TextInput
          accessibilityLabel="Message the agent"
          value={props.value}
          onChangeText={props.onChangeText}
          placeholder={
            props.placeholder ??
            (props.paused
              ? "Message the agent — it will wait in the queue…"
              : "Send a follow-up...")
          }
          placeholderTextColor={c["fg-subtle"]}
          multiline
          autoFocus={props.autoFocus}
          onContentSizeChange={(event) =>
            setHeight(Math.min(160, Math.max(24, event.nativeEvent.contentSize.height)))
          }
          style={{
            ...fontStyle(theme),
            fontSize: theme.size.composer,
            lineHeight: 24,
            color: c.fg,
            paddingTop: 12,
            paddingHorizontal: 14,
            paddingBottom: 4,
            minHeight: 44,
            height: Platform.OS === "android" ? undefined : height + 16,
            maxHeight: 176,
            textAlignVertical: "top",
          }}
        />
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 8,
            paddingBottom: 8,
            gap: 4,
          }}
        >
          {props.renderLeading ? (
            props.renderLeading()
          ) : props.onAttach ? (
            <IconButton
              icon="plus"
              accessibilityLabel="More composer actions"
              onPress={props.onAttach}
            />
          ) : null}
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", minWidth: 0 }}>
            {props.options}
          </View>
          {showPause ? (
            <IconButton
              icon={props.paused ? "play" : "pause"}
              tone="secondary"
              accessibilityLabel={props.paused ? "Resume this workstream" : "Pause this workstream"}
              onPress={props.paused ? props.onResume : props.onPause}
              busy={props.pauseBusy}
            />
          ) : null}
          <IconButton
            icon="arrow-up"
            tone="primary"
            accessibilityLabel="Send message"
            onPress={props.onSend}
            disabled={!props.canSend}
            busy={props.sending}
          />
        </View>
      </View>
    </Animated.View>
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
  leading?: ReactNode;
}) {
  const theme = useNativeTimelineTheme();
  return (
    <View style={{ flexShrink: 1 }}>
      <Text
        onPress={onPress}
        accessibilityRole="button"
        numberOfLines={1}
        style={{
          ...fontStyle(theme, 500),
          fontSize: theme.size.sm,
          lineHeight: 44,
          paddingHorizontal: 8,
          color: theme.colors.fg,
        }}
      >
        {leading}
        {label} ⌄
      </Text>
    </View>
  );
}
