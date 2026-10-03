import { stringifyPayload } from "@opengeni/react/timeline-model";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View, type TextStyle } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { Icon, type NativeIconName } from "./icon";
import { fontStyle, useNativeTimelineTheme, type NativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   Native counterparts of the web timeline primitives (timeline/shared.tsx).
   Same anatomy and tokens: chevron, tinted icon, title, quiet preview, at most
   one right-gutter chip; the body mounts only when expanded.
   -------------------------------------------------------------------------- */

export type DisclosureChip = { tone: "ok" | "bad" | "muted" | "interrupted"; text: string };
export type IconTone = "accent" | "failed" | "running" | "muted";

export function iconToneColor(theme: NativeTimelineTheme, tone: IconTone): string {
  switch (tone) {
    case "accent":
      return theme.colors.accent;
    case "failed":
      return theme.colors["status-failed"];
    case "running":
      return theme.colors["status-running"];
    default:
      return theme.colors["fg-subtle"];
  }
}

/** Web `pointer-coarse:min-h-11`: every disclosure row is a 44pt touch target. */
export const ROW_MIN_HEIGHT = 44;

export function Chip({ chip }: { chip: DisclosureChip }) {
  const theme = useNativeTimelineTheme();
  const text: TextStyle = {
    ...fontStyle(theme, 400, "mono"),
    fontSize: theme.size.xs,
    lineHeight: theme.size.xs + 2,
    color: chip.tone === "bad" ? theme.colors["status-failed"] : theme.colors["fg-subtle"],
  };
  if (chip.tone === "bad") {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: chip.text ? 6 : 0 }}>
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: theme.colors["status-failed"],
          }}
        />
        {chip.text ? <Text style={text}>{chip.text}</Text> : null}
      </View>
    );
  }
  return <Text style={text}>{chip.text}</Text>;
}

/** The web `animate-og-pulse` dot that rides a running preview. */
export function PulseDot({ color, size = 6 }: { color: string; size?: number }) {
  const value = useSharedValue(1);
  useEffect(() => {
    value.value = withRepeat(
      withTiming(0.35, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(value);
  }, [value]);
  const style = useAnimatedStyle(() => ({ opacity: value.value }));
  return (
    <Animated.View
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]}
    />
  );
}

/**
 * The web `og-shimmer-text` (a moving fg-subtle → fg → fg-subtle gradient) as an
 * ink sweep between the same two tokens.
 */
export function ShimmerText({
  children,
  style,
  active = true,
  numberOfLines,
}: {
  children: ReactNode;
  style?: TextStyle | TextStyle[];
  active?: boolean;
  numberOfLines?: number;
}) {
  const theme = useNativeTimelineTheme();
  const value = useSharedValue(0);
  useEffect(() => {
    if (!active) return;
    value.value = withRepeat(
      withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
    return () => cancelAnimation(value);
  }, [active, value]);
  const subtle = theme.colors["fg-subtle"];
  const strong = theme.colors.fg;
  const animated = useAnimatedStyle(() => ({
    color: interpolateColor(value.value, [0, 1], [subtle, strong]),
  }));
  if (!active) {
    return (
      <Text style={style} numberOfLines={numberOfLines}>
        {children}
      </Text>
    );
  }
  return (
    <Animated.Text style={[style, animated]} numberOfLines={numberOfLines}>
      {children}
    </Animated.Text>
  );
}

export interface ActivityDisclosureProps {
  icon: NativeIconName | ReactNode;
  iconTone?: IconTone | undefined;
  title: ReactNode;
  titleMono?: boolean | undefined;
  /** Title shimmer + preview pulse while in flight. */
  running?: boolean | undefined;
  preview?: ReactNode | undefined;
  chip?: DisclosureChip | undefined;
  failed?: boolean | undefined;
  cancelled?: boolean | undefined;
  expandable?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  /** Compact reel rendering for the rolling status (no chevron, no body). */
  compact?: boolean | undefined;
  accessibilityLabel?: string | undefined;
  children?: ReactNode | undefined;
}

/** The one row shape every activity uses, matching the web ActivityDisclosure. */
export function ActivityDisclosure({
  icon,
  iconTone: iconToneProp = "muted",
  title,
  titleMono,
  running,
  preview,
  chip: chipProp,
  failed,
  cancelled,
  expandable = true,
  defaultOpen,
  compact,
  accessibilityLabel,
  children,
}: ActivityDisclosureProps) {
  const theme = useNativeTimelineTheme();
  const [open, setOpen] = useState(defaultOpen ?? false);
  const iconTone = failed && iconToneProp === "muted" ? "failed" : iconToneProp;
  const chip =
    chipProp ??
    (failed
      ? ({ tone: "bad", text: "failed" } as const)
      : cancelled
        ? ({ tone: "interrupted", text: "interrupted" } as const)
        : undefined);
  const tint = iconToneColor(theme, iconTone);
  const iconNode =
    typeof icon === "string" ? <Icon name={icon as NativeIconName} size={14} color={tint} /> : icon;
  const titleStyle: TextStyle = titleMono
    ? {
        ...fontStyle(theme, 400, "mono"),
        fontSize: theme.size.sm,
        lineHeight: 20,
        color: theme.colors["fg-muted"],
      }
    : {
        ...fontStyle(theme, 500),
        fontSize: theme.size.base,
        lineHeight: 20,
        color: theme.colors["fg-muted"],
      };
  const previewStyle: TextStyle = {
    ...fontStyle(theme),
    fontSize: theme.size.sm,
    lineHeight: 18,
    color: theme.colors["fg-subtle"],
  };
  const titleNode =
    typeof title === "string" ? (
      <ShimmerText style={titleStyle} active={Boolean(running)} numberOfLines={1}>
        {title}
      </ShimmerText>
    ) : (
      title
    );
  const previewNode =
    preview == null ? null : typeof preview === "string" ? (
      <Text style={[previewStyle, { flexShrink: 1 }]} numberOfLines={1}>
        {preview}
      </Text>
    ) : (
      preview
    );

  if (compact) {
    // Web `og-rolling-label`: 13px/450 muted title (never mono), subtle preview.
    const reelTitle: TextStyle = {
      ...fontStyle(theme, 400),
      fontSize: 13,
      lineHeight: 20,
      color: theme.colors["fg-muted"],
    };
    const reelPreview: TextStyle = {
      ...fontStyle(theme, 400),
      fontSize: 13,
      lineHeight: 20,
      color: theme.colors["fg-subtle"],
    };
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
        {iconNode}
        <View style={{ flexShrink: 0, maxWidth: preview == null ? "100%" : "75%" }}>
          {typeof title === "string" ? (
            <ShimmerText style={reelTitle} active={Boolean(running)} numberOfLines={1}>
              {title}
            </ShimmerText>
          ) : (
            title
          )}
        </View>
        {preview == null ? null : (
          <View style={{ flex: 1, minWidth: 0 }}>
            {typeof preview === "string" ? (
              <Text style={reelPreview} numberOfLines={1}>
                {preview}
              </Text>
            ) : (
              preview
            )}
          </View>
        )}
      </View>
    );
  }

  const hasBody = expandable && children != null;
  const row = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: ROW_MIN_HEIGHT,
        paddingHorizontal: 6,
        paddingVertical: 10,
        borderRadius: theme.radius.sm,
      }}
    >
      {hasBody ? (
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon name="chevron-right" size={14} color={theme.colors["fg-subtle"]} />
        </View>
      ) : (
        <View style={{ width: 14 }} />
      )}
      {iconNode}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
        <View style={{ flexShrink: 1, minWidth: 0 }}>{titleNode}</View>
        {previewNode && !open ? <View style={{ flex: 1, minWidth: 0 }}>{previewNode}</View> : null}
      </View>
      {chip && !open ? (
        <View style={{ paddingLeft: 8 }}>
          <Chip chip={chip} />
        </View>
      ) : null}
    </View>
  );
  if (!hasBody) return row;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={accessibilityLabel ?? (typeof title === "string" ? title : undefined)}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => ({
          borderRadius: theme.radius.sm,
          backgroundColor: pressed ? theme.colors["surface-1"] : "transparent",
        })}
      >
        {row}
      </Pressable>
      {open ? (
        <View style={{ marginLeft: 28, marginTop: 6, marginBottom: 8, gap: 8 }}>{children}</View>
      ) : null}
    </View>
  );
}

/** A running preview: the pulse locus immediately left of the status words. */
export function RunningPreview({ text, compact }: { text: string; compact?: boolean }) {
  const theme = useNativeTimelineTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 }}>
      {compact ? null : <PulseDot color={theme.colors["status-running"]} />}
      <Text
        numberOfLines={1}
        style={{
          ...fontStyle(theme),
          fontSize: compact ? 13 : theme.size.sm,
          lineHeight: compact ? 20 : 18,
          color: theme.colors["fg-subtle"],
          flexShrink: 1,
        }}
      >
        {text}
      </Text>
    </View>
  );
}

function RuledBlock({
  tone,
  children,
}: {
  tone: "neutral" | "failed" | "live";
  children: ReactNode;
}) {
  const theme = useNativeTimelineTheme();
  const borderColor =
    tone === "failed"
      ? withAlpha(theme.colors["status-failed"], 0.5)
      : tone === "live"
        ? withAlpha(theme.colors["status-running"], 0.5)
        : theme.colors.border;
  return (
    <View
      style={{ borderLeftWidth: 2, borderLeftColor: borderColor, paddingLeft: 12, minWidth: 0 }}
    >
      {children}
    </View>
  );
}

export function TermBlock({
  command,
  workdir,
  output,
  live,
  failed,
  tailLines = 12,
}: {
  command: string | null;
  workdir?: string | null | undefined;
  output: string;
  live?: boolean | undefined;
  failed?: boolean | undefined;
  tailLines?: number;
}) {
  const theme = useNativeTimelineTheme();
  const [full, setFull] = useState(false);
  const lines = output.split("\n");
  const big = lines.length > tailLines + 4;
  const shown = full || !big ? output : lines.slice(-tailLines).join("\n");
  const mono: TextStyle = {
    ...fontStyle(theme, 400, "mono"),
    fontSize: theme.size.xs,
    lineHeight: 20,
  };
  const showHeader = command != null || Boolean(workdir);
  return (
    <RuledBlock tone={failed ? "failed" : live ? "live" : "neutral"}>
      {showHeader ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 4 }}>
          <Text style={[mono, { color: theme.colors["status-idle"] }]}>$</Text>
          <Text
            style={[mono, { fontSize: theme.size.sm, color: theme.colors["fg-muted"], flex: 1 }]}
            numberOfLines={1}
          >
            {command ?? ""}
          </Text>
          {workdir ? (
            <Text
              style={[mono, { color: theme.colors["fg-subtle"], flexShrink: 1 }]}
              numberOfLines={1}
            >
              {workdir}
            </Text>
          ) : null}
        </View>
      ) : null}
      {output.trim() === "" ? (
        <Text style={[mono, { fontStyle: "italic", color: theme.colors["fg-subtle"] }]}>
          (no output)
        </Text>
      ) : (
        <ScrollView style={{ maxHeight: 288 }} nestedScrollEnabled>
          <Text selectable style={[mono, { color: theme.colors["fg-muted"] }]}>
            {shown}
          </Text>
        </ScrollView>
      )}
      {big && !full ? (
        <Pressable onPress={() => setFull(true)} accessibilityRole="button">
          <Text
            style={{
              ...fontStyle(theme),
              marginTop: 4,
              fontSize: theme.size.xs,
              color: theme.colors["fg-subtle"],
            }}
          >
            show full output ({lines.length} lines)
          </Text>
        </Pressable>
      ) : null}
    </RuledBlock>
  );
}

export function PayloadBlock({
  label,
  value,
  failed,
}: {
  label: string;
  value: unknown;
  failed?: boolean | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const text = typeof value === "string" ? value : stringifyPayload(value);
  if (!text || text.trim() === "") return null;
  return (
    <RuledBlock tone={failed ? "failed" : "neutral"}>
      <Text
        style={{
          ...fontStyle(theme, 500),
          marginBottom: 4,
          fontSize: theme.size.xs,
          letterSpacing: theme.size.xs * 0.08,
          textTransform: "uppercase",
          color: theme.colors["fg-subtle"],
        }}
      >
        {label}
      </Text>
      <ScrollView style={{ maxHeight: 256 }} nestedScrollEnabled>
        <Text
          selectable
          style={{
            ...fontStyle(theme, 400, "mono"),
            fontSize: theme.size.xs,
            lineHeight: 20,
            color: failed ? theme.colors["status-failed"] : theme.colors["fg-muted"],
          }}
        >
          {text}
        </Text>
      </ScrollView>
    </RuledBlock>
  );
}

export function BodyNote({ children, tone }: { children: ReactNode; tone?: "error" | undefined }) {
  const theme = useNativeTimelineTheme();
  if (tone === "error") {
    return (
      <RuledBlock tone="failed">
        <Text
          style={{
            ...fontStyle(theme, 400, "mono"),
            fontSize: theme.size.xs,
            lineHeight: 20,
            color: theme.colors["status-failed"],
          }}
        >
          {children}
        </Text>
      </RuledBlock>
    );
  }
  return (
    <Text
      style={{
        ...fontStyle(theme),
        paddingHorizontal: 2,
        fontSize: theme.size.sm,
        lineHeight: 20,
        fontStyle: "italic",
        color: theme.colors["fg-subtle"],
      }}
    >
      {children}
    </Text>
  );
}

/** `rgb(r, g, b)` / `#rrggbb` → rgba with the given alpha (Tailwind `/50`). */
export function withAlpha(color: string, alpha: number): string {
  const rgb = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  const hex = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (hex)
    return `rgba(${parseInt(hex[1]!, 16)}, ${parseInt(hex[2]!, 16)}, ${parseInt(hex[3]!, 16)}, ${alpha})`;
  return color;
}
