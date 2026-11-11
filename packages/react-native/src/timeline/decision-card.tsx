import { createContext, useContext, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View, type ViewStyle } from "react-native";
import { Icon, type NativeIconName } from "./icon";
import { withAlpha } from "./primitives";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   One card language for every moment the agent waits on the person, as on
   the web (components/decision-card.tsx): a calm neutral surface, the decision
   as the heading with a quiet status line, one strong action, and buttons
   that stack full width under the thumb while the card is narrow.
   -------------------------------------------------------------------------- */

/** Cards at least this wide put their actions on one line, as the web card does. */
const WIDE_CARD = 448;

/** Whether the surrounding actions row is on one line (buttons size to their label). */
const ActionsWide = createContext(false);

export function DecisionCard({
  children,
  settled = false,
  accessibilityLabel,
  style,
}: {
  children: ReactNode;
  /** A decided card drops its lift and reads as part of the conversation. */
  settled?: boolean | undefined;
  accessibilityLabel?: string | undefined;
  style?: ViewStyle | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[
        {
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: c.border,
          // Opaque: the approval card floats over the scrolling conversation.
          backgroundColor: c["surface-1"],
        },
        settled
          ? null
          : {
              shadowColor: "#000",
              shadowOpacity: theme.scheme === "dark" ? 0.3 : 0.08,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 4 },
              elevation: 2,
            },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** The small square beside the heading. */
export function DecisionMark({ icon }: { icon: NativeIconName }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: 36,
        height: 36,
        borderRadius: theme.radius.md,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: withAlpha(c.fg, 0.06),
      }}
    >
      <Icon name={icon} size={18} color={c["fg-muted"]} />
    </View>
  );
}

/** "● Approval needed · Work account": a quiet status line under the heading. */
export function DecisionMeta({
  parts,
  waiting = false,
}: {
  parts: readonly (string | null | undefined | false)[];
  waiting?: boolean | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const text = parts.filter(Boolean).join(" · ");
  if (!text) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
      {waiting ? (
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: c["status-waiting"],
          }}
        />
      ) : null}
      <Text
        style={{
          ...fontStyle(theme),
          flexShrink: 1,
          fontSize: theme.size.sm,
          lineHeight: 18,
          color: c["fg-muted"],
        }}
      >
        {text}
      </Text>
    </View>
  );
}

export type DecisionButtonKind = "primary" | "danger" | "secondary" | "quiet";

export function DecisionButton({
  kind = "secondary",
  label,
  onPress,
  busy = false,
  disabled = false,
  icon,
  accessibilityLabel,
}: {
  kind?: DecisionButtonKind | undefined;
  label: string;
  onPress?: (() => void) | undefined;
  busy?: boolean | undefined;
  disabled?: boolean | undefined;
  icon?: NativeIconName | undefined;
  accessibilityLabel?: string | undefined;
}) {
  const wide = useContext(ActionsWide);
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const palette =
    kind === "primary"
      ? { bg: c.fg, border: c.fg, fg: c.bg }
      : kind === "danger"
        ? { bg: c["danger-fill"], border: c["danger-fill"], fg: c["danger-fg"] }
        : kind === "quiet"
          ? { bg: "transparent", border: "transparent", fg: c["fg-muted"] }
          : { bg: c["surface-1"], border: c.border, fg: c.fg };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        alignSelf: wide ? "auto" : "stretch",
        paddingHorizontal: 16,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.bg,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        opacity: disabled && !busy ? 0.55 : pressed ? 0.8 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={palette.fg} />
      ) : icon ? (
        <Icon name={icon} size={15} color={palette.fg} />
      ) : null}
      <Text
        numberOfLines={1}
        style={{
          ...fontStyle(theme, 500),
          fontSize: theme.size.base,
          lineHeight: 18,
          color: palette.fg,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The actions row. Give the primary first. Narrow cards stack full-width
 * buttons with the primary on top and the `lead` (details, hint) last; wide
 * cards put the lead at the start and the buttons on one line at the end,
 * primary last.
 */
export function DecisionActions({
  primary,
  secondary,
  lead,
  style,
}: {
  primary?: ReactNode;
  secondary?: ReactNode;
  lead?: ReactNode;
  style?: ViewStyle | undefined;
}) {
  const [width, setWidth] = useState(0);
  const wide = width >= WIDE_CARD;
  return (
    <ActionsWide.Provider value={wide}>
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={[
          wide
            ? { flexDirection: "row", alignItems: "center", gap: 8 }
            : { flexDirection: "column", alignItems: "stretch", gap: 8 },
          style,
        ]}
      >
        {wide ? (
          <>
            {lead ? (
              <View style={{ flexDirection: "row", alignItems: "center", flexShrink: 1, gap: 12 }}>
                {lead}
              </View>
            ) : null}
            <View style={{ flex: 1 }} />
            {secondary}
            {primary}
          </>
        ) : (
          <>
            {primary}
            {secondary}
            {lead ? (
              <View
                style={{
                  flexDirection: "row",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 12,
                }}
              >
                {lead}
              </View>
            ) : null}
          </>
        )}
      </View>
    </ActionsWide.Provider>
  );
}

/** A quiet text action for the lead slot (Details, Skip). */
export function DecisionLink({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        minHeight: 36,
        justifyContent: "center",
        paddingHorizontal: 4,
        opacity: disabled ? 0.55 : pressed ? 0.7 : 1,
      })}
    >
      <Text
        style={{
          ...fontStyle(theme, 500),
          fontSize: theme.size.sm,
          color: c["fg-muted"],
          textDecorationLine: "underline",
          textDecorationColor: withAlpha(c["fg-muted"], 0.4),
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
