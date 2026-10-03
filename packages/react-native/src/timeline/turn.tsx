import type { ActivityItem, TurnOutcome } from "@opengeni/react/session";
import {
  createTurnSummaryContext,
  formatElapsed,
  GENIE_PREPARING_PHRASES,
  GENIE_WAITING_PHRASES,
  resolveTurnSummaryFacets,
  rollingActivityItem,
  selectTurnSummaryFacets,
  toolDisplayName,
  type TurnSummaryFacetConfiguration,
} from "@opengeni/react/timeline-model";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Pressable, Text, View, type TextStyle } from "react-native";
import Animated, { FadeIn, FadeInDown, FadeOut, FadeOutUp } from "react-native-reanimated";
import { ActivityRow } from "./activity";
import { Icon } from "./icon";
import { PulseDot, ShimmerText, ROW_MIN_HEIGHT } from "./primitives";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   Native TurnSummary / ActivityRail / RollingActivity — the web components of
   the same names (timeline/turn-summary.tsx, activity-rail.tsx,
   rolling-activity.tsx) in their rolling-turn configuration.
   -------------------------------------------------------------------------- */

/** Native counterpart of the web `TurnSummaryStatus` with a renderable preview. */
export type NativeTurnStatus =
  | { kind: "worked"; durationMs?: number | undefined; label?: string | undefined }
  | {
      kind: "working" | "waiting";
      since?: string | undefined;
      label?: string | undefined;
      preview?: ReactNode;
    };

type FoldMemory = Map<string, "open" | "closed">;
const FoldMemoryContext = createContext<FoldMemory | null>(null);
export const FoldMemoryProvider = FoldMemoryContext.Provider;

export function useLiveNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function LiveElapsed({ since, style }: { since: string; style: TextStyle }) {
  const startedAt = Date.parse(since);
  const now = useLiveNow(true);
  if (!Number.isFinite(startedAt)) return null;
  return (
    <Text
      style={[style, { fontVariant: ["tabular-nums"] }]}
    >{` · ${formatElapsed(Math.max(0, now - startedAt))}`}</Text>
  );
}

export interface TurnSummaryProps {
  items: ActivityItem[];
  outcome?: TurnOutcome | undefined;
  failureText?: string | undefined;
  durationMs?: number | undefined;
  defaultOpen?: boolean | undefined;
  liveHeader?: ReactNode;
  bare?: boolean | undefined;
  facets?: TurnSummaryFacetConfiguration | undefined;
  foldKey?: string | undefined;
  contextCompactionCount?: number | undefined;
  status?: NativeTurnStatus | undefined;
  children: ReactNode;
}

export function TurnSummary({
  items,
  outcome,
  failureText,
  durationMs,
  defaultOpen,
  liveHeader,
  bare,
  facets: facetConfiguration,
  foldKey,
  contextCompactionCount,
  status,
  children,
}: TurnSummaryProps) {
  const theme = useNativeTimelineTheme();
  const foldMemory = useContext(FoldMemoryContext);
  const remembered = foldKey !== undefined ? foldMemory?.get(foldKey) : undefined;
  const [open, setOpen] = useState(
    remembered === "closed" ? false : remembered === "open" ? true : (defaultOpen ?? false),
  );
  const readerOwnsOpen = useRef(remembered !== undefined);
  useEffect(() => {
    if (status && defaultOpen && remembered === undefined && !readerOwnsOpen.current) setOpen(true);
  }, [status, defaultOpen, remembered]);
  const toggle = (next: boolean) => {
    readerOwnsOpen.current = true;
    if (foldKey !== undefined) foldMemory?.set(foldKey, next ? "open" : "closed");
    setOpen(next);
  };
  const context = useMemo(
    () =>
      createTurnSummaryContext(
        items,
        outcome,
        failureText,
        durationMs,
        contextCompactionCount ?? 0,
      ),
    [items, outcome, failureText, durationMs, contextCompactionCount],
  );
  const definitions = useMemo(
    () => resolveTurnSummaryFacets(facetConfiguration),
    [facetConfiguration],
  );
  const facets = useMemo(
    () => selectTurnSummaryFacets(definitions, context, status?.kind),
    [definitions, context, status?.kind],
  );
  const liveShell = outcome === undefined && open && !bare;
  const text: TextStyle = {
    ...fontStyle(theme),
    fontSize: bare ? theme.size.sm : theme.size.base,
    lineHeight: 20,
    color: liveShell && !status ? theme.colors["fg-subtle"] : theme.colors["fg-muted"],
  };
  const showMarker = !(
    status ||
    outcome === "complete" ||
    (!outcome && (liveHeader || context.settled))
  );
  const facetText = facets
    .map(({ result }) =>
      typeof result.content === "string" || typeof result.content === "number"
        ? String(result.content)
        : "",
    )
    .filter(Boolean);

  let statusNode: ReactNode = null;
  let hasStatusText = false;
  if (status?.kind === "worked") {
    if (
      status.durationMs !== undefined &&
      Number.isFinite(status.durationMs) &&
      status.durationMs >= 1000
    ) {
      hasStatusText = true;
      statusNode = (
        <Text
          style={text}
        >{`${status.label ?? "Worked for"} ${formatElapsed(status.durationMs)}`}</Text>
      );
    }
  } else if (status) {
    hasStatusText = true;
    const label = status.label ?? (status.kind === "working" ? "Working" : "Waiting");
    statusNode = (
      <>
        <ShimmerText style={text} active={status.kind === "working"}>
          {label}
        </ShimmerText>
        {status.since ? <LiveElapsed since={status.since} style={text} /> : null}
      </>
    );
  }
  const showLive = Boolean(liveHeader) && !open && !status;
  const tail =
    (showLive
      ? ""
      : facetText
          .map((value, index) => (index > 0 || hasStatusText ? ` · ${value}` : value))
          .join("")) + "";

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => toggle(!open)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          minHeight: ROW_MIN_HEIGHT,
          paddingVertical: 10,
          borderRadius: theme.radius.sm,
          // Web `-mx-2 px-2 w-full`: shifted left 8 with the same width.
          ...(bare
            ? { gap: 8, paddingHorizontal: 6 }
            : { gap: 10, paddingHorizontal: 8, marginLeft: -8, marginRight: 8 }),
          backgroundColor: pressed
            ? theme.colors["surface-1"]
            : !bare && open
              ? theme.colors.bg
              : "transparent",
        })}
      >
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon name="chevron-right" size={14} color={theme.colors["fg-subtle"]} />
        </View>
        {showMarker ? (
          <View
            style={{
              width: bare ? 14 : 20,
              height: bare ? 14 : 20,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {outcome === "failed" ? (
              <Icon name="triangle-alert" size={12} color={theme.colors["status-failed"]} />
            ) : outcome === "cancelled" ? (
              <Icon name="circle-slash" size={12} color={theme.colors["fg-subtle"]} />
            ) : (
              <PulseDot color={theme.colors["fg-subtle"]} />
            )}
          </View>
        ) : null}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            minWidth: 0,
            ...(status?.kind === "worked" ? { flexShrink: 1 } : { flex: 1 }),
          }}
        >
          {statusNode}
          {showLive ? (
            <View style={{ flex: 1, minWidth: 0 }}>{liveHeader}</View>
          ) : (
            <Text style={[text, { flexShrink: 1 }]} numberOfLines={1}>
              {tail}
              {outcome === "failed" && failureText ? (
                <Text style={{ color: theme.colors["status-failed"] }}>{` · ${failureText}`}</Text>
              ) : null}
              {outcome === "cancelled" ? (
                <Text style={{ color: theme.colors["fg-subtle"] }}>{" · interrupted"}</Text>
              ) : null}
            </Text>
          )}
        </View>
        {status?.kind === "worked" ? (
          <View
            style={{
              marginLeft: 4,
              height: 1,
              flex: 1,
              minWidth: 0,
              backgroundColor: theme.colors.border,
            }}
          />
        ) : null}
        {status && status.kind !== "worked" && (contextCompactionCount ?? 0) > 0 ? (
          <Icon name="shrink" size={14} color={theme.colors["fg-muted"]} />
        ) : null}
      </Pressable>
      {status && status.kind !== "worked" && !open && status.preview ? (
        <Pressable
          onPress={() => toggle(true)}
          style={{ paddingBottom: 4, paddingLeft: 24, minWidth: 0 }}
        >
          {status.preview}
        </Pressable>
      ) : null}
      {open ? (
        <Animated.View
          entering={FadeIn.duration(160)}
          style={bare ? { paddingTop: 4, paddingLeft: 20 } : { paddingTop: 8 }}
        >
          {children}
        </Animated.View>
      ) : null}
    </View>
  );
}

/** The stable left rule under a turn/activity body (web TurnRailFrame). */
export function TurnRailFrame({
  children,
  compact = false,
}: {
  children: ReactNode;
  compact?: boolean;
}) {
  const theme = useNativeTimelineTheme();
  return (
    <View
      style={{
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.border,
        paddingLeft: 12,
        gap: compact ? 2 : 16,
      }}
    >
      {children}
    </View>
  );
}

function familyOf(item: ActivityItem): string {
  if (item.kind === "tool-call") return `tool:${item.name}`;
  return item.kind;
}

/** The native ActivityRail (bare): tight same-family rows, breathing room between families. */
export function ActivityRail({
  items,
  startupActive,
  renderPreparing,
}: {
  items: ActivityItem[];
  startupActive?: boolean | undefined;
  renderPreparing?: ((props: PreparingProps) => ReactNode) | undefined;
}) {
  const phases = items.filter((item) => item.kind === "startup-phase");
  const hasWork = items.some(
    (item) =>
      item.kind !== "startup-phase" && (item.kind !== "reasoning" || item.text.trim().length > 0),
  );
  const interrupted = phases.some(
    (item) => item.status === "failed" || item.status === "cancelled",
  );
  const providerResponded = phases.some(
    (item) => item.phase === "provider_first_byte" && item.status === "complete",
  );
  const responsePending = phases.some((item) => item.phase === "provider_first_byte");
  const loading =
    !hasWork &&
    !interrupted &&
    (startupActive ?? (!providerResponded && phases.some((item) => item.status === "running")));
  const visibleItems = items.filter((item) =>
    item.kind === "startup-phase"
      ? item.status === "failed" || item.status === "cancelled"
      : item.kind !== "reasoning" || item.text.trim().length > 0,
  );
  const startedAt = phases.reduce(
    (first, item) => (item.startedAt < first ? item.startedAt : first),
    phases[0]?.startedAt ?? "",
  );
  return (
    <View style={{ gap: 2 }}>
      {loading ? (
        <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(160)}>
          <PreparingState
            startedAt={startedAt}
            phase={responsePending ? "waiting" : "preparing"}
            render={renderPreparing}
          />
        </Animated.View>
      ) : null}
      {visibleItems.map((item, index) => {
        const newFamily = index > 0 && familyOf(item) !== familyOf(visibleItems[index - 1]!);
        return (
          <View key={item.id} style={newFamily ? { marginTop: 12 } : undefined}>
            <ActivityRow item={item} />
          </View>
        );
      })}
    </View>
  );
}

export interface PreparingProps {
  startedAt: string;
  phase: "preparing" | "waiting";
  phrase: string;
  slow: boolean;
}

/** The web GenieLoading: a visual (orb by default; hosts supply a character) + rotating copy. */
export function PreparingState({
  startedAt,
  phase,
  render,
}: {
  startedAt: string;
  phase: "preparing" | "waiting";
  render?: ((props: PreparingProps) => ReactNode) | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const phrases = phase === "waiting" ? GENIE_WAITING_PHRASES : GENIE_PREPARING_PHRASES;
  const [index, setIndex] = useState(() => Math.floor(Math.random() * phrases.length));
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const update = () => {
      setSlow(Date.now() - Date.parse(startedAt) >= 30_000);
      setIndex(Math.floor(Math.random() * phrases.length));
    };
    const timer = setInterval(update, 5_000);
    return () => clearInterval(timer);
  }, [startedAt, phrases]);
  const phrase = slow
    ? phase === "waiting"
      ? "Still waiting for a response…"
      : "A little longer than usual…"
    : (phrases[index % phrases.length] ?? "");
  if (render) return <>{render({ startedAt, phase, phrase, slow })}</>;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 14,
        minHeight: 88,
        paddingVertical: 12,
      }}
    >
      <Orb />
      <Animated.Text
        key={phrase}
        entering={FadeIn.duration(650)}
        style={{
          ...fontStyle(theme),
          fontSize: theme.size.sm,
          lineHeight: 18,
          color: theme.colors["fg-muted"],
        }}
      >
        {phrase}
      </Animated.Text>
    </View>
  );
}

/** A calm native stand-in for the web canvas orb. */
function Orb() {
  const theme = useNativeTimelineTheme();
  return (
    <View style={{ width: 64, height: 64, alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          backgroundColor: theme.colors["surface-3"],
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <PulseDot color={theme.colors["fg-subtle"]} size={10} />
      </View>
    </View>
  );
}

/** One stable 24pt viewport; updates replace its content without moving the conversation. */
export function RollingActivity({
  items,
  previousItem,
  showCount = true,
}: {
  items: ActivityItem[];
  previousItem?: ActivityItem | undefined;
  showCount?: boolean;
}) {
  const theme = useNativeTimelineTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const selected = rollingActivityItem(items, previousItem, mounted);
  if (!selected) return null;
  const { item, earlierCount } = selected;
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", gap: 12, minWidth: 0, flex: 1 }}
      accessibilityLabel={
        item.kind === "tool-call"
          ? toolDisplayName(item.name, item.display)
          : item.kind === "reasoning"
            ? "Thinking"
            : "Working"
      }
    >
      <View style={{ flex: 1, minWidth: 0, height: 24, overflow: "hidden" }}>
        <Animated.View
          key={item.id}
          entering={FadeInDown.duration(400)}
          exiting={FadeOutUp.duration(400)}
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            flexDirection: "row",
            alignItems: "center",
          }}
        >
          <ActivityRow item={item} compact />
        </Animated.View>
      </View>
      {showCount && earlierCount > 0 ? (
        <Text
          style={{
            ...fontStyle(theme),
            fontSize: theme.size.xs,
            color: theme.colors["fg-subtle"],
            fontVariant: ["tabular-nums"],
          }}
        >
          {`+${earlierCount} earlier`}
        </Text>
      ) : null}
    </View>
  );
}
