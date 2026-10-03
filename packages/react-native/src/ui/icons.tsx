// Minimal stroke icon set (Lucide geometry, ISC) so the kit has no icon-font dependency.
import Svg, { Circle, Path, Polyline, Rect } from "react-native-svg";

export type AgentIconName =
  | "terminal"
  | "search"
  | "edit"
  | "globe"
  | "check"
  | "x"
  | "chevron-right"
  | "chevron-down"
  | "sparkle"
  | "mic"
  | "plus"
  | "arrow-up"
  | "stop"
  | "tool"
  | "send"
  | "alert"
  | "question"
  | "rocket";

export function AgentIcon({
  name,
  size = 18,
  color,
  strokeWidth = 2,
}: {
  name: AgentIconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}) {
  const common = {
    stroke: color,
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {name === "terminal" ? (
        <>
          <Polyline points="4 17 10 11 4 5" {...common} />
          <Path d="M12 19h8" {...common} />
        </>
      ) : null}
      {name === "search" ? (
        <>
          <Circle cx="11" cy="11" r="7" {...common} />
          <Path d="m20 20-3.5-3.5" {...common} />
        </>
      ) : null}
      {name === "edit" ? (
        <>
          <Path d="M12 20h9" {...common} />
          <Path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" {...common} />
        </>
      ) : null}
      {name === "globe" ? (
        <>
          <Circle cx="12" cy="12" r="9" {...common} />
          <Path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" {...common} />
        </>
      ) : null}
      {name === "check" ? <Polyline points="20 6 9 17 4 12" {...common} /> : null}
      {name === "x" ? <Path d="M18 6 6 18M6 6l12 12" {...common} /> : null}
      {name === "chevron-right" ? <Polyline points="9 18 15 12 9 6" {...common} /> : null}
      {name === "chevron-down" ? <Polyline points="6 9 12 15 18 9" {...common} /> : null}
      {name === "sparkle" ? (
        <Path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" {...common} />
      ) : null}
      {name === "mic" ? (
        <>
          <Rect x="9" y="2" width="6" height="12" rx="3" {...common} />
          <Path d="M5 10a7 7 0 0 0 14 0M12 17v5" {...common} />
        </>
      ) : null}
      {name === "plus" ? <Path d="M12 5v14M5 12h14" {...common} /> : null}
      {name === "arrow-up" ? <Path d="M12 19V5M5 12l7-7 7 7" {...common} /> : null}
      {name === "stop" ? <Rect x="6" y="6" width="12" height="12" rx="2" fill={color} /> : null}
      {name === "tool" ? (
        <Path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4Z" {...common} />
      ) : null}
      {name === "send" ? <Path d="m22 2-7 20-4-9-9-4Z M22 2 11 13" {...common} /> : null}
      {name === "alert" ? (
        <>
          <Path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" {...common} />
          <Path d="M12 9v4M12 17h.01" {...common} />
        </>
      ) : null}
      {name === "question" ? (
        <>
          <Circle cx="12" cy="12" r="9" {...common} />
          <Path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01" {...common} />
        </>
      ) : null}
      {name === "rocket" ? (
        <>
          <Path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1Z" {...common} />
          <Path d="m12 15-3-3a22 22 0 0 1 2-4A13 13 0 0 1 22 2c0 2.7-.8 7.5-6 11a22 22 0 0 1-4 2Z" {...common} />
        </>
      ) : null}
    </Svg>
  );
}

/** Category icon for a tool name (best effort, purely presentational). */
export function toolIconName(name: string): AgentIconName {
  const leaf = name.toLowerCase();
  if (/exec|command|shell|bash|terminal|run/.test(leaf)) return "terminal";
  if (/search|find|grep|list|query|read/.test(leaf)) return "search";
  if (/patch|edit|write|create|update|save/.test(leaf)) return "edit";
  if (/web|browse|fetch|http|url/.test(leaf)) return "globe";
  if (/deploy|release|ship/.test(leaf)) return "rocket";
  return "tool";
}