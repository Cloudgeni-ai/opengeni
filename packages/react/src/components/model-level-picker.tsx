import type { ReasoningEffort } from "@opengeni/sdk";
import { ZapIcon } from "lucide-react";
import {
  AnimatePresence,
  animateValue,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type MotionValue,
} from "motion/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "../lib/cn";
import { useOpenGeniText } from "../messages/runtime";
import {
  modelLevelChoice,
  modelLevelsView,
  type ModelLevel,
  type ModelLevelsView,
} from "../model-levels";
import { ModelPolicyPicker, type ModelPolicyPickerProps } from "./model-policy-picker";

export type { ModelLevel };

export type ModelLevelPickerProps = ModelPolicyPickerProps & {
  /**
   * The host's levels, in order from lightest to most thorough. Two or three
   * read best. When none of them can run here the full picker shows instead.
   */
  levels: readonly ModelLevel[];
  /**
   * A new chat starts on the first level: when its model or effort is outside
   * the levels (for example the workspace default), the first level is chosen
   * once the catalog loads. Without it, an existing chat on another model
   * keeps that model and shows its name.
   */
  startOnFirstLevel?: boolean | undefined;
};

/*
 * The composer's level control. The level name sits in a small strip you
 * tap or swipe; dots show where you are. On a level that allows Ultrafast,
 * pressing and holding charges it (on the last level, pushing past the end
 * does too), and letting go fully charged turns it on. A tap can never turn
 * Ultrafast on.
 */

const SPRING = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 } as const;
const SETTLE = { type: "spring", stiffness: 320, damping: 30 } as const;
/** How far past the end a push must travel to charge Ultrafast. */
const OVERDRIVE_PX = 44;
/** How long a held arrow key past the end, or a held Space, takes to charge Ultrafast. */
const KEY_CHARGE_MS = 700;
/** A press shorter than this is a tap; longer starts charging Ultrafast. */
const HOLD_DELAY_MS = 180;
/** How long a held press then takes to fill the charge. */
const HOLD_CHARGE_MS = 480;
const HOLD_HINT_KEY = "opengeni.modelLevels.holdHintSeen";
let holdHintSeen = false;

/** True once, the first time someone lands on a level that offers Ultrafast. */
function takeHoldHint(): boolean {
  if (holdHintSeen) return false;
  holdHintSeen = true;
  try {
    if (window.localStorage.getItem(HOLD_HINT_KEY)) return false;
    window.localStorage.setItem(HOLD_HINT_KEY, "1");
  } catch {
    // No storage: the hint shows once per page load.
  }
  return true;
}
const DRAG_SLOP_PX = 4;

const running = new WeakMap<MotionValue<number>, { stop: () => void }>();

/**
 * Animate one motion value, replacing any animation already running on it.
 * (motion's `animate()` also does this, but it brings the object animator,
 * which the web app's code splitting cannot place without a chunk cycle.)
 */
function tween(
  value: MotionValue<number>,
  to: number,
  transition: Record<string, unknown> | null,
): { stop: () => void } {
  running.get(value)?.stop();
  if (transition === null || value.get() === to) {
    value.set(to);
    running.delete(value);
    return { stop: () => {} };
  }
  const animation = animateValue<number>({
    keyframes: [value.get(), to],
    velocity: value.getVelocity(),
    ...transition,
    onUpdate: (latest) => value.set(latest),
  });
  running.set(value, animation);
  return animation;
}

/** Stop whatever animation is moving a value, so a finger or key can take it. */
function halt(value: MotionValue<number>) {
  running.get(value)?.stop();
  running.delete(value);
}

function haptic(ms: number) {
  if (typeof navigator !== "undefined") navigator.vibrate?.(ms);
}

/** iOS-style resistance: the further you pull, the less it follows. */
function rubber(distance: number, limit: number) {
  return (limit * distance) / (limit + Math.abs(distance));
}

export function ModelLevelPicker(props: ModelLevelPickerProps) {
  const t = useOpenGeniText();
  const view = modelLevelsView(t, {
    levels: props.levels,
    rows: props.rows,
    models: props.models,
    model: props.model,
    effort: props.effort,
    latencyMode: props.latencyMode,
    ultrafastUsageHint: props.messages?.ultrafastUsageHint,
  });
  const commit = (index: number, ultrafast: boolean) => {
    if (!view) return;
    const choice = modelLevelChoice(view, index, ultrafast);
    if (!choice) return;
    if (choice.model !== props.model) props.onModelChange(choice.model);
    if (choice.effort !== props.effort) props.onEffortChange(choice.effort as ReasoningEffort);
    if (choice.latencyMode !== props.latencyMode) props.onLatencyModeChange(choice.latencyMode);
  };
  const outside = !props.loading && view !== null && view.index < 0;
  const started = useRef(false);
  useEffect(() => {
    if (!props.startOnFirstLevel || !outside || started.current) return;
    started.current = true;
    commit(0, false);
    // Once per mount, as soon as the catalog shows the chat is outside the levels.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.startOnFirstLevel, outside]);
  if (props.loading) {
    return (
      <span
        className={cn(
          "og-root inline-flex h-8 w-28 shrink-0 animate-pulse rounded-full bg-og-surface-2",
          props.className,
        )}
        aria-label={t("modelLevelPicker.loading")}
        data-testid="model-level-picker-loading"
      />
    );
  }
  if (!view) {
    const { levels: _levels, startOnFirstLevel: _start, ...picker } = props;
    return <ModelPolicyPicker {...picker} />;
  }
  return (
    <LevelStrip
      view={view}
      disabled={props.disabled === true}
      className={props.className}
      onCommit={commit}
    />
  );
}

/**
 * The composer's model control: the host's levels when it passes any, the
 * full picker otherwise. Passing no levels is the switch back to the full
 * picker (for example for organizations that should keep every option).
 */
export function ComposerModelPicker(
  props: ModelPolicyPickerProps & {
    levels?: readonly ModelLevel[] | undefined;
    startOnFirstLevel?: boolean | undefined;
  },
) {
  const { levels, startOnFirstLevel, ...picker } = props;
  return levels && levels.length > 0 ? (
    <ModelLevelPicker {...picker} levels={levels} startOnFirstLevel={startOnFirstLevel} />
  ) : (
    <ModelPolicyPicker {...picker} />
  );
}

function LevelStrip(props: {
  view: ModelLevelsView;
  disabled: boolean;
  className: string | undefined;
  onCommit: (index: number, ultrafast: boolean) => void;
}) {
  const t = useOpenGeniText();
  const reduce = useReducedMotion() === true;
  const { view } = props;
  const count = view.levels.length;
  const custom = view.index < 0;
  const index = Math.max(0, view.index);
  const canCharge = !custom && !view.ultrafast && view.levels[index]!.ultrafastAvailable;
  const atEnd = index === count - 1;
  const labels = view.levels.map((state) => state.level.label);

  const itemRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [widths, setWidths] = useState<number[]>([]);
  const x = useMotionValue(0);
  const charge = useMotionValue(0);
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const [ignitions, setIgnitions] = useState(0);
  const [flash, setFlash] = useState<FlashNote | null>(null);
  const drag = useRef<{ startX: number; startOffset: number; moved: boolean } | null>(null);
  const keyHold = useRef<{ key: string; start: number; repeated: boolean; done: boolean } | null>(
    null,
  );
  const hold = useRef<{ timer: number | null; charging: boolean; stop: (() => void) | null }>({
    timer: null,
    charging: false,
    stop: null,
  });
  useEffect(() => () => clearHold(), []);

  const labelKey = labels.join("\u0000");
  useLayoutEffect(() => {
    setWidths(itemRefs.current.slice(0, count).map((el) => el?.offsetWidth ?? 0));
  }, [labelKey, count, custom]);

  const offsetOf = (i: number) => widths.slice(0, i).reduce((sum, w) => sum + w, 0);
  const target = -offsetOf(index);
  const viewport = widths[index] ?? 0;

  useEffect(() => {
    if (drag.current) return;
    tween(x, target, reduce ? null : SPRING);
  }, [target, reduce, x]);

  const fill = useTransform(charge, [0, 1], ["0%", "100%"]);
  const glow = useTransform(charge, [0, 0.15, 1], [0, 0.5, 1]);
  const boltScale = useTransform(charge, [0, 1], [0.4, 1.05]);
  const stretch = useTransform(charge, [0, 1], [0, 22]);

  const setArm = (on: boolean) => {
    if (armedRef.current === on) return;
    armedRef.current = on;
    setArmed(on);
    if (on) haptic(10);
  };
  /** Press and hold: after a moment the charge fills; full means let go to ignite. */
  const startHold = () => {
    hold.current.charging = true;
    haptic(4);
    // The fill is the picture; the timer decides, so a throttled frame never arms late.
    // animateValue takes milliseconds, unlike motion components.
    const controls = tween(charge, 1, { duration: HOLD_CHARGE_MS, ease: "linear" });
    hold.current.stop = () => controls.stop();
    hold.current.timer = window.setTimeout(() => {
      hold.current.timer = null;
      if (hold.current.charging) setArm(true);
    }, HOLD_CHARGE_MS);
  };
  function clearHold() {
    if (hold.current.timer !== null) window.clearTimeout(hold.current.timer);
    hold.current.stop?.();
    hold.current = { timer: null, charging: false, stop: null };
  }
  const settle = () => {
    clearHold();
    setArm(false);
    tween(charge, 0, reduce ? null : SETTLE);
    tween(x, target, reduce ? null : SPRING);
  };
  const ignite = () => {
    props.onCommit(index, true);
    setIgnitions((n) => n + 1);
    if (view.ultrafastCost) setFlash({ id: Date.now(), text: view.ultrafastCost, tone: "charge" });
    haptic(18);
  };
  const choose = (next: number) => {
    props.onCommit(next, false);
    haptic(8);
    if (view.levels[next]?.ultrafastAvailable && takeHoldHint()) {
      setFlash({ id: Date.now(), text: t("modelLevelPicker.holdForUltrafast"), tone: "hint" });
    }
  };
  /** A tap: turn Ultrafast off, or step one level deeper and wrap around. */
  const tap = () => {
    if (view.ultrafast) props.onCommit(index, false);
    else choose(custom ? 0 : (index + 1) % count);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (props.disabled || event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    halt(x);
    drag.current = { startX: event.clientX, startOffset: x.get(), moved: false };
    if (canCharge) hold.current.timer = window.setTimeout(startHold, HOLD_DELAY_MS);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const dx = event.clientX - state.startX;
    if (Math.abs(dx) > DRAG_SLOP_PX && !state.moved) {
      state.moved = true;
      // Moving turns a press into a swipe: any hold charge drains away.
      if (hold.current.timer !== null || hold.current.charging) {
        clearHold();
        charge.set(0);
        setArm(false);
      }
    }
    if (!state.moved || custom) return;
    // Pushing left reveals the next level, as in a carousel.
    const end = -offsetOf(count - 1);
    let next = state.startOffset + dx;
    if (next > 0) next = rubber(next, 30);
    if (next < end) {
      const over = end - next;
      // Past the end the name stays readable and the pill stretches instead.
      next = end - rubber(over, 5);
      if (canCharge && atEnd) {
        const level = Math.min(1, over / OVERDRIVE_PX);
        charge.set(level);
        setArm(level >= 1);
      }
    } else if (charge.get() > 0) {
      charge.set(0);
      setArm(false);
    }
    x.set(next);
  };
  const onPointerUp = () => {
    const state = drag.current;
    drag.current = null;
    if (!state) return;
    const held = hold.current.charging;
    if (hold.current.timer !== null) window.clearTimeout(hold.current.timer);
    hold.current.timer = null;
    if (held) {
      // A hold never steps the level: full ignites, short of full drains away.
      if (armedRef.current) ignite();
      return settle();
    }
    if (!state.moved) return tap();
    if (custom) return choose(0);
    if (armedRef.current) {
      ignite();
      return settle();
    }
    // Land on the level whose name is nearest the window.
    const offset = -x.get();
    let nearest = index;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i += 1) {
      const distance = Math.abs(offsetOf(i) + (widths[i] ?? 0) / 2 - offset - viewport / 2);
      if (distance < best) {
        best = distance;
        nearest = i;
      }
    }
    if (nearest !== index) choose(nearest);
    settle();
  };
  const onPointerCancel = () => {
    drag.current = null;
    settle();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (props.disabled) return;
    const deeper = event.key === "ArrowRight" || event.key === "ArrowUp";
    const lighter = event.key === "ArrowLeft" || event.key === "ArrowDown";
    if (deeper) {
      event.preventDefault();
      if (custom) return choose(0);
      if (index < count - 1) return choose(index + 1);
      if (!canCharge) return;
      // Holding the key at the end charges Ultrafast, like a push does.
      keyCharge(event.key, true);
    } else if (event.key === " ") {
      event.preventDefault();
      if (!canCharge) {
        if (!event.repeat) tap();
        return;
      }
      // Holding Space charges Ultrafast, like holding the pill; a press is a tap.
      if (!event.repeat)
        keyHold.current = { key: " ", start: performance.now(), repeated: false, done: false };
      else keyCharge(" ", false);
    } else if (lighter) {
      event.preventDefault();
      if (view.ultrafast) props.onCommit(index, false);
      else if (!custom && index > 0) choose(index - 1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      choose(event.key === "Home" ? 0 : count - 1);
    } else if (event.key === "Enter" && !event.repeat) {
      event.preventDefault();
      tap();
    }
  };
  const keyCharge = (key: string, push: boolean) => {
    if (keyHold.current?.key !== key) {
      keyHold.current = { key, start: performance.now(), repeated: true, done: false };
    }
    const state = keyHold.current;
    state.repeated = true;
    if (state.done) return;
    halt(charge);
    halt(x);
    const level = Math.min(1, (performance.now() - state.start) / KEY_CHARGE_MS);
    charge.set(level);
    if (push) x.set(target - rubber(level * OVERDRIVE_PX, 5));
    if (level >= 1) {
      state.done = true;
      ignite();
      settle();
    }
  };
  const onKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    const state = keyHold.current;
    if (state === null || state.key !== event.key) return;
    keyHold.current = null;
    if (state.key === " " && !state.repeated) tap();
    settle();
  };

  const current = view.levels[index]!.level.label;
  const valueText = custom
    ? t("modelLevelPicker.outsideLevels", { label: view.customLabel })
    : view.ultrafast
      ? t("modelLevelPicker.levelWithUltrafast", { label: current })
      : current;
  const hint = canCharge ? t("modelLevelPicker.holdForUltrafast") : undefined;

  return (
    <div
      role="slider"
      tabIndex={props.disabled ? -1 : 0}
      aria-label={t("modelLevelPicker.label")}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={count - 1}
      aria-valuenow={index}
      aria-valuetext={valueText}
      aria-description={hint}
      aria-disabled={props.disabled || undefined}
      title={hint}
      data-testid="model-level-picker"
      data-level={custom ? undefined : view.levels[index]!.level.id}
      data-ultrafast={view.ultrafast || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={() => {
        if (drag.current) onPointerCancel();
      }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      className={cn(
        "og-root og-model-level-picker relative inline-flex h-[var(--og-model-picker-trigger-height)] shrink-0 touch-none select-none [-webkit-touch-callout:none] items-center gap-1.5 rounded-full border px-2.5 text-og-control font-medium outline-hidden transition-[border-color,background-color] duration-200 focus-visible:ring-2 focus-visible:ring-og-accent/40 max-sm:h-11",
        props.disabled ? "cursor-not-allowed opacity-50" : "cursor-grab active:cursor-grabbing",
        view.ultrafast
          ? "border-og-charge/45 bg-og-charge/10 text-og-fg"
          : "border-transparent text-og-fg hover:border-og-border hover:bg-og-surface-2",
        props.className,
      )}
    >
      <motion.span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-transparent to-og-charge/30"
        style={{ width: fill, opacity: glow }}
      />
      <LevelDots
        count={count}
        index={custom ? -1 : index}
        charge={charge}
        ultrafast={view.ultrafast}
      />
      {custom ? (
        <span className="block max-w-40 truncate px-[5px] leading-[18px] text-og-fg-muted">
          {view.customLabel}
        </span>
      ) : null}
      <motion.span
        aria-hidden
        className={cn("relative block h-[18px] shrink-0 overflow-hidden", custom && "hidden")}
        initial={false}
        animate={viewport ? { width: viewport } : {}}
        transition={reduce ? { duration: 0 } : SPRING}
        style={{
          maskImage:
            "linear-gradient(90deg, transparent 0, #000 5px, #000 calc(100% - 5px), transparent 100%)",
        }}
      >
        <motion.span className="absolute left-0 top-0 flex whitespace-nowrap" style={{ x }}>
          {labels.map((label, i) => (
            <span
              key={view.levels[i]!.level.id}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              className="block px-[5px] leading-[18px]"
            >
              {label}
            </span>
          ))}
        </motion.span>
      </motion.span>
      <motion.span aria-hidden className="-ml-1.5 block shrink-0" style={{ width: stretch }} />
      {canCharge ? (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -mt-[7px] text-og-charge"
          style={{ scale: boltScale, opacity: glow }}
          animate={armed && !reduce ? { rotate: [0, -10, 10, -5, 0] } : { rotate: 0 }}
          transition={{ duration: 0.35 }}
        >
          <ZapIcon className={cn("size-3.5", armed && "fill-current")} />
        </motion.span>
      ) : null}
      <AnimatePresence initial={false}>
        {view.ultrafast ? (
          <motion.span
            key="bolts"
            aria-hidden
            className="flex -space-x-1.5 text-og-charge"
            initial={reduce ? { opacity: 0 } : { scale: 0.3, opacity: 0, rotate: -20 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={SPRING}
            data-testid="model-level-ultrafast"
          >
            <ZapIcon className="size-3.5 fill-current" />
            <ZapIcon className="size-3.5 fill-current" />
          </motion.span>
        ) : null}
      </AnimatePresence>
      <Flash note={flash} />
      <Ignition key={ignitions} active={ignitions > 0} reduce={reduce} />
    </div>
  );
}

function LevelDots(props: {
  count: number;
  index: number;
  charge: MotionValue<number>;
  ultrafast: boolean;
}) {
  const grow = useTransform(props.charge, [0, 1], [11, 18]);
  return (
    <span aria-hidden className="flex items-center gap-[3px]">
      {Array.from({ length: props.count }, (_, i) => {
        const active = i === props.index;
        return (
          <motion.span
            key={i}
            className="block h-1 rounded-full"
            initial={false}
            animate={{
              width: active ? 11 : 4,
              backgroundColor:
                active && props.ultrafast
                  ? "var(--og-color-charge)"
                  : active
                    ? "var(--og-color-fg)"
                    : "var(--og-color-fg-subtle)",
              opacity: active ? 1 : 0.5,
            }}
            style={active ? { minWidth: grow } : {}}
            transition={SPRING}
          />
        );
      })}
    </span>
  );
}

type FlashNote = { id: number; text: string; tone: "charge" | "hint" };

/**
 * A short note beside the level, said once and then folded away: what
 * Ultrafast costs as it turns on, or the first time, how to turn it on.
 */
function Flash(props: { note: FlashNote | null }) {
  const [visible, setVisible] = useState<FlashNote | null>(null);
  useEffect(() => {
    if (!props.note) return;
    setVisible(props.note);
    const timer = setTimeout(() => setVisible(null), props.note.tone === "hint" ? 2600 : 1900);
    return () => clearTimeout(timer);
  }, [props.note]);
  return (
    <AnimatePresence>
      {visible ? (
        <motion.span
          key={visible.id}
          role="status"
          className={cn(
            "overflow-hidden whitespace-nowrap text-og-xs font-medium",
            visible.tone === "charge" ? "text-og-charge" : "text-og-fg-muted",
          )}
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: "auto", opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          {visible.text}
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

const SPARKS = [0, 1, 2, 3, 4, 5, 6, 7];

/** The moment Ultrafast turns on: one ring and a few sparks from the bolt. */
function Ignition(props: { active: boolean; reduce: boolean }) {
  if (!props.active) return null;
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0">
      <motion.span
        className="absolute inset-0 rounded-full"
        style={{
          boxShadow: "0 0 0 1.5px var(--og-color-charge), 0 0 18px var(--og-color-charge)",
        }}
        initial={{ opacity: 0.9, scale: 1 }}
        animate={{ opacity: 0, scale: props.reduce ? 1 : 1.3 }}
        transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
      />
      {props.reduce
        ? null
        : SPARKS.map((i) => {
            const angle = (i / SPARKS.length) * Math.PI * 2 + 0.3;
            const distance = 20 + (i % 3) * 7;
            return (
              <motion.span
                key={i}
                className="absolute right-4 top-1/2 h-0.5 w-[7px] rounded-full bg-og-charge"
                style={{ rotate: `${(angle * 180) / Math.PI}deg` }}
                initial={{ x: 0, y: 0, opacity: 1, scaleX: 1.4 }}
                animate={{
                  x: Math.cos(angle) * distance,
                  y: Math.sin(angle) * distance * 0.7,
                  opacity: 0,
                  scaleX: 0.3,
                }}
                transition={{ duration: 0.5 + (i % 3) * 0.08, ease: [0.16, 1, 0.3, 1] }}
              />
            );
          })}
    </span>
  );
}
