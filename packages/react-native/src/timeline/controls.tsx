import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, type ViewStyle } from "react-native";
import { Icon, type NativeIconName } from "./icon";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* Web Button variants at `size="sm"` (h-9, rounded-og-md, text-og-sm font-medium). */

export type ButtonVariant = "primary" | "secondary" | "destructive" | "ghost";

export function Button({
  label,
  icon,
  onPress,
  variant = "secondary",
  disabled,
  busy,
  style,
  accessibilityLabel,
}: {
  label?: string | undefined;
  icon?: NativeIconName | undefined;
  onPress?: (() => void) | undefined;
  variant?: ButtonVariant;
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  style?: ViewStyle | undefined;
  accessibilityLabel?: string | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const palette =
    variant === "primary"
      ? { bg: c.primary, border: c["primary-border"], fg: c["primary-fg"] }
      : variant === "destructive"
        ? { bg: c["danger-fill"], border: c["danger-fill"], fg: c["danger-fg"] }
        : variant === "ghost"
          ? { bg: "transparent", border: "transparent", fg: c["fg-muted"] }
          : { bg: c["surface-2"], border: c.border, fg: c["fg-muted"] };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: 36,
          minWidth: label ? undefined : 44,
          paddingHorizontal: label ? 12 : 0,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: palette.border,
          backgroundColor: palette.bg,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={palette.fg} />
      ) : icon ? (
        <Icon name={icon} size={14} color={palette.fg} />
      ) : null}
      {label ? (
        <Text
          style={{
            ...fontStyle(theme, 500),
            fontSize: theme.size.sm,
            lineHeight: 18,
            color: palette.fg,
          }}
        >
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** A 44pt square icon control (composer toolbar buttons). */
export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  tone = "plain",
  disabled,
  busy,
  children,
}: {
  icon: NativeIconName;
  onPress?: (() => void) | undefined;
  accessibilityLabel: string;
  tone?: "plain" | "primary" | "secondary";
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  children?: ReactNode;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const framed = tone !== "plain";
  const fg = tone === "primary" ? c["primary-fg"] : c["fg-muted"];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: theme.radius.md,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: framed ? 1 : 0,
        borderColor: tone === "primary" ? c["primary-border"] : c.border,
        backgroundColor:
          tone === "primary"
            ? c.primary
            : tone === "secondary"
              ? c["surface-2"]
              : pressed
                ? c.hover
                : "transparent",
        opacity: disabled ? 0.45 : pressed && framed ? 0.85 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <Icon
          name={icon}
          size={icon === "pause" ? 14 : 16}
          color={fg}
          fill={icon === "pause" || icon === "play" ? fg : undefined}
        />
      )}
      {children}
    </Pressable>
  );
}
