import { MODE_FRAMES, resolvePreset, type OrbState } from "thinking-orbs/engine";
import { useEffect, useMemo, useState } from "react";
import { AccessibilityInfo, AppState } from "react-native";
import Svg, { Circle, Line } from "react-native-svg";
import { useNativeTimelineTheme } from "./theme";

/** About 30 frames a second: smooth at 64pt without spending a frame budget. */
const FRAME_MS = 33;

function ink(white: number, alpha: number | undefined, dark: boolean): string {
  // The engine's convention: 0 is the darkest ink on paper, mirrored on dark.
  const level = Math.round((dark ? 1 - Math.min(1, Math.max(0, white)) : white) * 255);
  return `rgba(${level},${level},${level},${alpha ?? 1})`;
}

/**
 * The web's ThinkingOrb on native: the same `thinking-orbs` geometry (one
 * frame of dots and edges per instant) drawn with SVG. Pauses in the
 * background and holds a still frame under Reduce Motion, as the web does.
 */
export function ThinkingOrb({
  state = "searching",
  size = 64,
  speed = 0.8,
  displaySize,
}: {
  state?: OrbState;
  size?: 64 | 20;
  speed?: number;
  /** Draw the tuned preset larger (for example a call screen) without losing sharpness. */
  displaySize?: number;
}) {
  const theme = useNativeTimelineTheme();
  const dark = theme.scheme === "dark";
  const preset = useMemo(() => resolvePreset(state, size), [state, size]);
  const [time, setTime] = useState(0.6);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    const app = AppState.addEventListener("change", (next) => setActive(next === "active"));
    return () => {
      motion.remove();
      app.remove();
    };
  }, []);
  useEffect(() => {
    if (reduceMotion || !active) return;
    const started = Date.now();
    const timer = setInterval(() => setTime((Date.now() - started) / 1000), FRAME_MS);
    return () => clearInterval(timer);
  }, [active, reduceMotion]);
  const frame = MODE_FRAMES[preset.mode](
    size,
    reduceMotion ? 0.6 : time * preset.speed * speed,
    preset.opts,
  );
  return (
    <Svg
      width={displaySize ?? size}
      height={displaySize ?? size}
      viewBox={`0 0 ${size} ${size}`}
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {frame.lines.map((line, index) => (
        <Line
          // Stateless drawing slots retain their keys as coordinates animate.
          // oxlint-disable-next-line react/no-array-index-key
          key={`l${index}`}
          x1={line.x1}
          y1={line.y1}
          x2={line.x2}
          y2={line.y2}
          stroke={ink(line.white, line.a, dark)}
          strokeWidth={line.w}
        />
      ))}
      {frame.dots.map((dot, index) => (
        <Circle
          // Stateless drawing slots retain their keys as coordinates animate.
          // oxlint-disable-next-line react/no-array-index-key
          key={`d${index}`}
          cx={dot.x}
          cy={dot.y}
          r={dot.r}
          fill={ink(dot.white, dot.a, dark)}
        />
      ))}
    </Svg>
  );
}
