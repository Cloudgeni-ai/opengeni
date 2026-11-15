import type { ClientModel, LatencyMode, ReasoningEffort } from "@opengeni/sdk";
import {
  modelLevelChoice,
  modelLevelsView,
  type ModelLevel,
  type ModelLevelsView,
} from "@opengeni/react/model-levels";
import type { PickerModelRow } from "@opengeni/react/model-policy";
import { useOpenGeniText } from "@opengeni/react/messages";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Animated,
  PanResponder,
  Text,
  View,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
} from "react-native";
import { Icon } from "./icon";
import { fontStyle, useNativeTimelineTheme } from "./theme";

/* ----------------------------------------------------------------------------
   The composer's level control, native. The web control's behaviour on
   native chrome: the level name slides in a small strip you tap or swipe,
   dots show where you are, and on a level that allows Ultrafast, pressing
   and holding charges it (on the last level a push past the end does too).
   A tap never turns Ultrafast on; VoiceOver and TalkBack get an explicit
   "Turn on Ultrafast" action instead of the gesture.
   Put it in `SessionComposer`'s `options` in place of the model pill.
   -------------------------------------------------------------------------- */

export type { ModelLevel };

export type ModelLevelFeedback = "level" | "armed" | "ultrafast";

export type ModelLevelControlProps = {
  /** The host's levels, lightest first. Two or three read best. */
  levels: readonly ModelLevel[];
  /** Catalog rows (availability truth). Takes precedence over `models`. */
  rows?: PickerModelRow[] | undefined;
  models?: ClientModel[] | undefined;
  model: string;
  effort: ReasoningEffort;
  latencyMode: LatencyMode;
  disabled?: boolean | undefined;
  onModelChange: (modelId: string) => void;
  onEffortChange: (effort: ReasoningEffort) => void;
  onLatencyModeChange: (mode: LatencyMode) => void;
  /** Host haptics: a level change, a fully charged push, Ultrafast turning on. */
  onSelectionFeedback?: ((kind: ModelLevelFeedback) => void) | undefined;
  /** What Ultrafast costs on a ChatGPT/Codex plan; default "8× usage". */
  ultrafastUsageHint?: string | undefined;
  /** Shown when none of the levels can run here, for example the model pill. */
  fallback?: ReactNode;
  /**
   * For a new chat: when its model or effort is outside the levels (for
   * example the workspace default), choose the first level once. Without it,
   * a chat on another model keeps that model and shows its name.
   */
  startOnFirstLevel?: boolean | undefined;
};

const OVERDRIVE_PX = 44;
const DRAG_SLOP_PX = 4;
const STRETCH_PX = 22;
/** A press shorter than this is a tap; longer starts charging Ultrafast. */
const HOLD_DELAY_MS = 180;
/** How long a held press then takes to fill the charge. */
const HOLD_CHARGE_MS = 480;
/** The how-to note shows once per app launch, the first time it applies. */
let holdHintSeen = false;

function rubber(distance: number, limit: number) {
  return (limit * distance) / (limit + Math.abs(distance));
}

function spring(value: Animated.Value, toValue: number, reduce: boolean) {
  if (reduce) {
    value.setValue(toValue);
    return;
  }
  Animated.spring(value, {
    toValue,
    stiffness: 520,
    damping: 38,
    mass: 0.7,
    useNativeDriver: false,
  }).start();
}

export function ModelLevelControl(props: ModelLevelControlProps) {
  const t = useOpenGeniText();
  const view = modelLevelsView(t, {
    levels: props.levels,
    rows: props.rows,
    models: props.models,
    model: props.model,
    effort: props.effort,
    latencyMode: props.latencyMode,
    ultrafastUsageHint: props.ultrafastUsageHint,
  });
  const commit = (index: number, ultrafast: boolean) => {
    if (!view) return;
    const choice = modelLevelChoice(view, index, ultrafast);
    if (!choice) return;
    if (choice.model !== props.model) props.onModelChange(choice.model);
    if (choice.effort !== props.effort) props.onEffortChange(choice.effort);
    if (choice.latencyMode !== props.latencyMode) props.onLatencyModeChange(choice.latencyMode);
  };
  const outside = view !== null && view.index < 0;
  const started = useRef(false);
  useEffect(() => {
    if (!props.startOnFirstLevel || !outside || started.current) return;
    started.current = true;
    commit(0, false);
    // Once per mount, as soon as the catalog shows the chat is outside the levels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.startOnFirstLevel, outside]);
  if (!view) return <>{props.fallback ?? null}</>;
  return (
    <LevelStrip
      view={view}
      disabled={props.disabled === true}
      onCommit={commit}
      onFeedback={props.onSelectionFeedback}
    />
  );
}

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled?.().then((value) => {
      if (live) setReduce(value);
    });
    const subscription = AccessibilityInfo.addEventListener?.("reduceMotionChanged", setReduce);
    return () => {
      live = false;
      subscription?.remove();
    };
  }, []);
  return reduce;
}

function LevelStrip(props: {
  view: ModelLevelsView;
  disabled: boolean;
  onCommit: (index: number, ultrafast: boolean) => void;
  onFeedback: ((kind: ModelLevelFeedback) => void) | undefined;
}) {
  const t = useOpenGeniText();
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const reduce = useReduceMotion();
  const { view } = props;
  const count = view.levels.length;
  const custom = view.index < 0;
  const index = Math.max(0, view.index);
  const canCharge = !custom && !view.ultrafast && view.levels[index]!.ultrafastAvailable;
  const atEnd = index === count - 1;

  const [widths, setWidths] = useState<number[]>([]);
  const x = useRef(new Animated.Value(0)).current;
  const windowWidth = useRef(new Animated.Value(0)).current;
  const charge = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState<{ id: number; text: string; tone: "charge" | "hint" } | null>(
    null,
  );
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; charging: boolean }>({
    timer: null,
    charging: false,
  });

  // The responder is created once; it reads the latest values from here.
  const live = useRef({
    view,
    index,
    custom,
    canCharge,
    atEnd,
    widths,
    reduce,
    props,
    t,
    armed: false,
  });
  live.current = {
    ...live.current,
    view,
    index,
    custom,
    canCharge,
    atEnd,
    widths,
    reduce,
    props,
    t,
  };

  const offsetOf = (list: number[], i: number) => list.slice(0, i).reduce((sum, w) => sum + w, 0);
  const measured = widths.length === count && widths.every((w) => w > 0);

  useEffect(() => {
    if (!measured) return;
    spring(x, -offsetOf(widths, index), reduce);
    spring(windowWidth, widths[index] ?? 0, reduce);
  }, [index, measured, widths, reduce, x, windowWidth]);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), note.tone === "hint" ? 2600 : 1900);
    return () => clearTimeout(timer);
  }, [note]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => clearHold(), []);

  const setArm = (on: boolean) => {
    if (live.current.armed === on) return;
    live.current.armed = on;
    setArmed(on);
    if (on) live.current.props.onFeedback?.("armed");
  };
  /** Press and hold: after a moment the charge fills; full means let go to ignite. */
  const startHold = () => {
    hold.current.charging = true;
    Animated.timing(charge, {
      toValue: 1,
      duration: HOLD_CHARGE_MS,
      useNativeDriver: false,
    }).start();
    // The fill is the picture; the timer decides, so a dropped frame never arms late.
    hold.current.timer = setTimeout(() => {
      hold.current.timer = null;
      if (hold.current.charging) setArm(true);
    }, HOLD_CHARGE_MS);
  };
  function clearHold() {
    if (hold.current.timer !== null) clearTimeout(hold.current.timer);
    if (hold.current.charging) charge.stopAnimation();
    hold.current = { timer: null, charging: false };
  }
  const ignite = () => {
    const { props: current, index: at, reduce: still } = live.current;
    current.onCommit(at, true);
    current.onFeedback?.("ultrafast");
    const cost = live.current.view.ultrafastCost;
    if (cost) setNote({ id: Date.now(), text: cost, tone: "charge" });
    ring.setValue(1);
    if (still) ring.setValue(0);
    else Animated.timing(ring, { toValue: 0, duration: 550, useNativeDriver: true }).start();
  };
  const choose = (next: number) => {
    const { view: v, t: text } = live.current;
    live.current.props.onCommit(next, false);
    live.current.props.onFeedback?.("level");
    if (v.levels[next]?.ultrafastAvailable && !holdHintSeen) {
      holdHintSeen = true;
      setNote({ id: Date.now(), text: text("modelLevelPicker.holdForUltrafast"), tone: "hint" });
    }
  };
  const tap = () => {
    const { view: v, index: at, custom: off } = live.current;
    if (v.ultrafast) live.current.props.onCommit(at, false);
    else choose(off ? 0 : (at + 1) % v.levels.length);
  };
  const settle = () => {
    clearHold();
    setArm(false);
    spring(charge, 0, live.current.reduce);
    const { widths: w, index: at } = live.current;
    spring(x, -offsetOf(w, at), live.current.reduce);
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !live.current.props.disabled,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          !live.current.props.disabled && Math.abs(gesture.dx) > DRAG_SLOP_PX,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          if (live.current.canCharge) hold.current.timer = setTimeout(startHold, HOLD_DELAY_MS);
        },
        onPanResponderMove: (_event, gesture) => {
          const { custom: off, widths: w, index: at, view: v } = live.current;
          const chargeable = live.current.canCharge && live.current.atEnd;
          if (Math.abs(gesture.dx) <= DRAG_SLOP_PX) return;
          // Moving turns a press into a swipe: any hold charge drains away.
          if (hold.current.timer !== null || hold.current.charging) {
            clearHold();
            charge.setValue(0);
            setArm(false);
          }
          if (off) return;
          const start = -offsetOf(w, at);
          const end = -offsetOf(w, v.levels.length - 1);
          let next = start + gesture.dx;
          if (next > 0) next = rubber(next, 30);
          if (next < end) {
            const over = end - next;
            next = end - rubber(over, 5);
            if (chargeable) {
              const level = Math.min(1, over / OVERDRIVE_PX);
              charge.setValue(level);
              setArm(level >= 1);
            }
          } else {
            charge.setValue(0);
            setArm(false);
          }
          x.setValue(next);
        },
        onPanResponderRelease: (_event, gesture) => {
          const { custom: off, widths: w, index: at, view: v } = live.current;
          const held = hold.current.charging;
          if (hold.current.timer !== null) clearTimeout(hold.current.timer);
          hold.current.timer = null;
          if (held) {
            // A hold never steps the level: full ignites, short of full drains away.
            if (live.current.armed) ignite();
            return settle();
          }
          if (Math.abs(gesture.dx) <= DRAG_SLOP_PX) return tap();
          if (off) return choose(0);
          if (live.current.armed) {
            ignite();
            return settle();
          }
          // Land on the level whose name is nearest the window.
          const offset = offsetOf(w, at) - gesture.dx;
          let nearest = at;
          let best = Number.POSITIVE_INFINITY;
          for (let i = 0; i < v.levels.length; i += 1) {
            const distance = Math.abs(offsetOf(w, i) - offset);
            if (distance < best) {
              best = distance;
              nearest = i;
            }
          }
          if (nearest !== at) choose(nearest);
          settle();
        },
        onPanResponderTerminate: () => settle(),
      }),
    // Values come from `live`; the animated values are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onItemLayout = (i: number) => (event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width);
    setWidths((current) => {
      if (current[i] === width) return current;
      const next = [...current];
      next[i] = width;
      return next.slice(0, count);
    });
  };

  const current = view.levels[index]!.level.label;
  const valueText = custom
    ? t("modelLevelPicker.outsideLevels", { label: view.customLabel })
    : view.ultrafast
      ? t("modelLevelPicker.levelWithUltrafast", { label: current })
      : current;
  const actions = [
    { name: "increment" as const },
    { name: "decrement" as const },
    ...(canCharge ? [{ name: "ultrafast", label: t("modelLevelPicker.turnOnUltrafast") }] : []),
    ...(view.ultrafast
      ? [{ name: "standardSpeed", label: t("modelLevelPicker.turnOffUltrafast") }]
      : []),
  ];
  const onAction = (event: AccessibilityActionEvent) => {
    const name = event.nativeEvent.actionName;
    if (name === "increment") {
      if (custom) choose(0);
      else if (index < count - 1) choose(index + 1);
    } else if (name === "decrement") {
      if (view.ultrafast) props.onCommit(index, false);
      else if (!custom && index > 0) choose(index - 1);
    } else if (name === "ultrafast" && canCharge) ignite();
    else if (name === "standardSpeed") props.onCommit(index, false);
  };

  const charged = view.ultrafast;
  const text = { ...fontStyle(theme, 500), fontSize: theme.size.sm, lineHeight: 18 };
  const tint = (alpha: number) => withAlpha(c.charge, alpha);

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={t("modelLevelPicker.label")}
      accessibilityHint={canCharge ? t("modelLevelPicker.holdForUltrafast") : undefined}
      accessibilityValue={{ text: valueText }}
      accessibilityState={{ disabled: props.disabled }}
      accessibilityActions={actions}
      onAccessibilityAction={onAction}
      testID="model-level-control"
      {...responder.panHandlers}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        minHeight: 44,
        paddingHorizontal: 10,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: charged ? tint(0.45) : "transparent",
        backgroundColor: charged ? tint(0.1) : "transparent",
        opacity: props.disabled ? 0.5 : 1,
        flexShrink: 0,
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: 0,
          borderRadius: 999,
          backgroundColor: tint(0.22),
          width: charge.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
          opacity: charge.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.5, 1] }),
        }}
      />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
        {view.levels.map((state, i) => {
          const active = !custom && i === index;
          return (
            <Animated.View
              key={state.level.id}
              style={{
                height: 4,
                borderRadius: 2,
                width: active
                  ? charge.interpolate({ inputRange: [0, 1], outputRange: [11, 18] })
                  : 4,
                backgroundColor: active ? (charged ? c.charge : c.fg) : c["fg-subtle"],
                opacity: active ? 1 : 0.5,
              }}
            />
          );
        })}
      </View>
      {custom ? (
        <Text numberOfLines={1} style={{ ...text, color: c["fg-muted"], maxWidth: 140 }}>
          {view.customLabel}
        </Text>
      ) : (
        <Animated.View
          style={{
            height: 18,
            overflow: "hidden",
            width: measured ? windowWidth : undefined,
          }}
        >
          <Animated.View
            style={{
              flexDirection: "row",
              position: measured ? "absolute" : "relative",
              left: 0,
              top: 0,
              transform: [{ translateX: x }],
            }}
          >
            {view.levels.map((state, i) => (
              <Text
                key={state.level.id}
                numberOfLines={1}
                onLayout={onItemLayout(i)}
                style={{ ...text, color: c.fg, paddingHorizontal: 2 }}
              >
                {state.level.label}
              </Text>
            ))}
          </Animated.View>
        </Animated.View>
      )}
      <Animated.View
        style={{
          marginLeft: -6,
          width: charge.interpolate({ inputRange: [0, 1], outputRange: [0, STRETCH_PX] }),
        }}
      />
      {canCharge ? (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            right: 8,
            opacity: charge.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.5, 1] }),
            transform: [
              { scale: charge.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1.05] }) },
            ],
          }}
        >
          <Icon name="zap" size={14} color={c.charge} fill={armed ? c.charge : undefined} />
        </Animated.View>
      ) : null}
      {charged ? (
        <View style={{ flexDirection: "row" }} testID="model-level-ultrafast">
          <Icon name="zap" size={13} color={c.charge} fill={c.charge} />
          <View style={{ marginLeft: -6 }}>
            <Icon name="zap" size={13} color={c.charge} fill={c.charge} />
          </View>
        </View>
      ) : null}
      {note ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{
            ...fontStyle(theme, 500),
            fontSize: theme.size.xs,
            color: note.tone === "charge" ? c.charge : c["fg-muted"],
          }}
        >
          {note.text}
        </Text>
      ) : null}
      <Animated.View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: -1,
          bottom: -1,
          left: -1,
          right: -1,
          borderRadius: 999,
          borderWidth: 1.5,
          borderColor: c.charge,
          opacity: ring,
          transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1.3, 1] }) }],
        }}
      />
    </View>
  );
}

/** `rgb(r, g, b)` from the generated tokens with an alpha. */
function withAlpha(color: string, alpha: number): string {
  const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!match) return color;
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
}
