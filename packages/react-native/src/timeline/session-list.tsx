import type { ClientModel, Session, SessionStatus } from "@opengeni/sdk";
import { SESSION_STATUS_BADGE, SESSION_STATUS_PRESENTATION } from "@opengeni/react/timeline-model";
import { MODEL_MARK_PATHS, modelMarkVendor } from "@opengeni/react/model-mark-paths";
import { projectClientModelRows } from "@opengeni/react/model-policy";
import {
  recentSessionModelPresentation,
  recentSessionStatus,
  relativeTimeLabel,
  sessionDisplayTitle,
  sessionRepoLabel,
  type SessionStatusTone,
} from "@opengeni/react/session-list-model";
import { useEffect, useMemo } from "react";
import { Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { Icon } from "./icon";
import { withAlpha } from "./primitives";
import { fontStyle, useNativeTimelineTheme, type WebColorToken } from "./theme";

/* ----------------------------------------------------------------------------
   The web app's session list rows at phone width (Recent sessions on the
   home canvas): status dot, title, maker mark + catalog model label, and a
   compact relative time. Ordering and labels come from the shared
   session-list model so web and native read identically.
   -------------------------------------------------------------------------- */

const TONE_COLOR: Record<SessionStatusTone, WebColorToken> = {
  queued: "status-queued",
  running: "status-running",
  waiting: "status-waiting",
  idle: "status-idle",
  failed: "status-failed",
  cancelled: "status-cancelled",
};

/** The web StatusDot: an 8pt dot with a gentle pulse for live states. */
export function StatusDot({
  tone,
  pulse,
  size = 8,
}: {
  tone: SessionStatusTone;
  pulse?: boolean;
  size?: number;
}) {
  const theme = useNativeTimelineTheme();
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (!pulse || reduceMotion) {
      cancelAnimation(opacity);
      opacity.value = 1;
      return;
    }
    // Tailwind animate-pulse: 2s, cubic-bezier(0.4, 0, 0.6, 1), 1 → 0.5 → 1.
    opacity.value = withRepeat(
      withTiming(0.5, { duration: 1000, easing: Easing.bezier(0.4, 0, 0.6, 1) }),
      -1,
      true,
    );
    return () => cancelAnimation(opacity);
  }, [opacity, pulse, reduceMotion]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: theme.colors[TONE_COLOR[tone]],
        },
        style,
      ]}
    />
  );
}

/** The model maker's logo (OpenAI, Claude, Grok) with the web's neutral fallback. */
export function ModelMark({
  model,
  size = 12,
  color,
}: {
  model: string;
  size?: number;
  color: string;
}) {
  const vendor = modelMarkVendor(model);
  if (!vendor) return <Icon name="sparkles" size={size} color={color} />;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
      <Path d={MODEL_MARK_PATHS[vendor]} fill={color} />
    </Svg>
  );
}

export interface SessionRowProps {
  session: Session;
  /** The deployment's client model catalog, for catalog labels. */
  models: readonly ClientModel[];
  onPress: () => void;
  now?: Date | undefined;
}

/** One recent-session row, as the web home canvas renders it. */
export function SessionRow({ session, models, onPress, now }: SessionRowProps) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const rows = useMemo(() => projectClientModelRows([...models]), [models]);
  const title = sessionDisplayTitle(session);
  const status = recentSessionStatus(session);
  const model = recentSessionModelPresentation(session.model, rows);
  const repo = sessionRepoLabel(session);
  const meta = [model.label, repo].filter(Boolean).join(" · ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 4,
        paddingVertical: 10,
        borderRadius: theme.radius.md,
        backgroundColor: pressed ? c.hover : "transparent",
      })}
    >
      <StatusDot tone={status.tone} pulse={status.pulse} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{ ...fontStyle(theme, 400), fontSize: 14, lineHeight: 20, color: c.fg }}
        >
          {title}
        </Text>
        {meta ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
            <ModelMark model={session.model} size={12} color={c["fg-muted"]} />
            <Text
              numberOfLines={1}
              style={{
                ...fontStyle(theme, 400),
                fontSize: 11,
                lineHeight: 16,
                color: c["fg-subtle"],
                flexShrink: 1,
              }}
            >
              {meta}
            </Text>
          </View>
        ) : null}
      </View>
      <Text
        style={{
          ...fontStyle(theme, 400),
          fontSize: 11,
          lineHeight: 16,
          color: c["fg-subtle"],
          fontVariant: ["tabular-nums"],
        }}
      >
        {relativeTimeLabel(session.updatedAt, now)}
      </Text>
    </Pressable>
  );
}

/** A small-caps section label (web: text-2xs semibold uppercase tracking-wider). */
export function SectionLabel({ children }: { children: string }) {
  const theme = useNativeTimelineTheme();
  return (
    <Text
      accessibilityRole="header"
      style={{
        ...fontStyle(theme, 600),
        fontSize: 11,
        lineHeight: 16,
        letterSpacing: 0.55,
        textTransform: "uppercase",
        color: theme.colors.fg,
        paddingHorizontal: 2,
        marginBottom: 6,
      }}
    >
      {children}
    </Text>
  );
}

/** The web's divided list: rows separated by a hairline in border/60. */
export function SessionRowList(props: {
  sessions: readonly Session[];
  models: readonly ClientModel[];
  onOpen: (sessionId: string) => void;
}) {
  const theme = useNativeTimelineTheme();
  return (
    <View>
      {props.sessions.map((session, index) => (
        <View
          key={session.id}
          style={
            index > 0
              ? {
                  borderTopWidth: 1,
                  borderColor: theme.colors.border,
                  borderTopColor: withAlpha(theme.colors.border, 0.6),
                }
              : undefined
          }
        >
          <SessionRow
            session={session}
            models={props.models}
            onPress={() => props.onOpen(session.id)}
          />
        </View>
      ))}
    </View>
  );
}

/** The web session status badge: tinted pill, breathing dot for live states. */
export function SessionStatusBadge({ status, label }: { status: SessionStatus; label?: string }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const presentation = SESSION_STATUS_PRESENTATION[status];
  const badge = SESSION_STATUS_BADGE[status];
  const color = (token: string) => c[token as WebColorToken] ?? c["fg-muted"];
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`Status: ${label ?? presentation.label}`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: withAlpha(color(badge.border), badge.borderAlpha),
        backgroundColor: withAlpha(color(badge.fill), 0.1),
      }}
    >
      <StatusDot tone={presentation.tone} pulse={presentation.pulse} size={6} />
      <Text
        style={{ ...fontStyle(theme, 500), fontSize: 12, lineHeight: 16, color: color(badge.text) }}
      >
        {label ?? presentation.label}
      </Text>
    </View>
  );
}

/**
 * A native navigation-bar title for a session: the title on one line and, under
 * it, the run state as a status dot and quiet label (the web header badge's
 * information without boxing a pill inside the bar's glass).
 */
export function SessionHeaderTitle({
  title,
  status,
  statusLabel,
  align = Platform.OS === "ios" ? "center" : "left",
  sideInset = 116,
}: {
  title: string;
  status: SessionStatus | null;
  /** Override the label ("Paused" for a paused workstream). */
  statusLabel?: string | undefined;
  align?: "center" | "left";
  /**
   * Room kept clear on each side of a centered title: the wider of the bar's
   * leading and trailing buttons plus their margin (a back button and a
   * two-button pill take about 116pt), so a long title truncates instead of
   * running under them.
   */
  sideInset?: number | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const viewport = useWindowDimensions();
  const presentation = status ? SESSION_STATUS_PRESENTATION[status] : null;
  // A settled, idle session needs no status line: the title stands alone, as in
  // native messaging apps. Running, waiting, paused and failed states still say so.
  const label = statusLabel ?? (status === "idle" ? undefined : presentation?.label);
  // Live and attention states take their status colour; settled ones stay quiet.
  const emphasized =
    presentation?.tone === "running" ||
    presentation?.tone === "waiting" ||
    presentation?.tone === "failed";
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={label ? `${title}, ${label}` : title}
      // iOS sizes a custom title view once, often before the session (and its
      // title) has loaded; a fixed width keeps a late title from collapsing to
      // "H…". Centered, it stays clear of the wider side's buttons on both sides.
      style={
        align === "center"
          ? {
              alignItems: "center",
              width: Math.max(120, Math.min(260, viewport.width - 2 * sideInset)),
            }
          : { alignItems: "flex-start", maxWidth: 240 }
      }
    >
      <Text
        numberOfLines={1}
        style={{ ...fontStyle(theme, 600), fontSize: 16, lineHeight: 20, color: c.fg }}
      >
        {title}
      </Text>
      {presentation && label ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5, marginTop: 1 }}>
          <StatusDot tone={presentation.tone} pulse={presentation.pulse} size={6} />
          <Text
            numberOfLines={1}
            style={{
              ...fontStyle(theme, 500),
              fontSize: 12,
              lineHeight: 15,
              color: emphasized ? c[TONE_COLOR[presentation.tone]] : c["fg-muted"],
            }}
          >
            {label}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
