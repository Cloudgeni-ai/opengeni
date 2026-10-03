import {
  sandboxRowTitle,
  startupDuration,
  startupPhaseTitle,
  STARTUP_WAIT_TITLES,
} from "./platform-activity-presentation";
import type { ReasoningItem, SandboxItem, StartupPhaseItem } from "./types";

type RowJsx = typeof import("react/jsx-runtime").jsx;
type RowJsxs = typeof import("react/jsx-runtime").jsxs;

export default function PlatformActivityRow({
  item,
  d: ActivityDisclosure,
  p: PayloadBlock,
  t: displayName,
  b: BotIcon,
  m: Markdown,
  j,
  s,
}: {
  item: ReasoningItem | SandboxItem | StartupPhaseItem;
  d: typeof import("./shared").ActivityDisclosure;
  p: typeof import("./shared").PayloadBlock;
  t: (name: string) => string;
  b: typeof import("lucide-react").BotIcon;
  m: typeof import("../components/markdown").Markdown;
  j: RowJsx;
  s: RowJsxs;
}) {
  if (item.kind === "reasoning") {
    return j(ActivityDisclosure, {
      icon: brainIcon(j, s),
      iconTone: "muted",
      title: item.streaming
        ? "Thinking"
        : j("span", {
            className: "font-normal italic text-og-fg-subtle",
            children: "Thought",
          }),
      running: item.streaming,
      compactPreview: item.text.replace(/\*\*|__|`/g, "").replace(/\s+/g, " "),
      preview: j("span", {
        className: "og-reasoning-preview",
        children: j(Markdown, { streaming: item.streaming, children: item.text }),
      }),
      children: j("div", {
        className: "text-og-base leading-6 text-og-fg-muted [&_strong]:text-og-fg-muted",
        children: j(Markdown, { streaming: item.streaming, children: item.text }),
      }),
    });
  }
  if (item.kind === "sandbox") {
    return s(ActivityDisclosure, {
      icon: terminalIcon(j, s),
      iconTone:
        item.status === "failed" ? "failed" : item.status === "running" ? "running" : "muted",
      title: sandboxRowTitle(item, displayName),
      running: item.status === "running",
      failed: item.status === "failed",
      cancelled: item.status === "cancelled",
      preview: item.command ?? undefined,
      children: [
        item.command ? j(PayloadBlock, { label: "Command", value: item.command }, "command") : null,
        item.output ? j(PayloadBlock, { label: "Output", value: item.output }, "output") : null,
      ],
    });
  }

  const failed = item.status === "failed";
  const running = item.status === "running";
  const duration = startupDuration(item.durationMs);
  return j(ActivityDisclosure, {
    icon: j(BotIcon, { className: "size-3.5" }),
    iconTone: failed ? "failed" : running ? "running" : "muted",
    title: item.blockedReason
      ? STARTUP_WAIT_TITLES[item.blockedReason]
      : startupPhaseTitle(item.phase, item.status, item.outcome),
    preview:
      item.phase === "model_preparation"
        ? "Includes overlapping sandbox startup, custom environment setup, repository preparation, and runtime setup shown below."
        : undefined,
    running,
    failed,
    cancelled: item.status === "cancelled",
    chip: duration ? { tone: failed ? "bad" : "muted", text: duration } : undefined,
    expandable: false,
  });
}

function brainIcon(j: RowJsx, s: RowJsxs) {
  return lucideIcon(j, s, "brain", [
    j("path", { d: "M 12 18V5" }, "spine"),
    j("path", { d: "M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" }, "center"),
    j("path", { d: "M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" }, "top"),
    j("path", { d: "M17.997 5.125a4 4 0 0 1 2.526 5.77" }, "upper-right"),
    j("path", { d: "M18 18a4 4 0 0 0 2-7.464" }, "right"),
    j("path", { d: "M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" }, "base"),
    j("path", { d: "M6 18a4 4 0 0 1-2-7.464" }, "left"),
    j("path", { d: "M6.003 5.125a4 4 0 0 0-2.526 5.77" }, "upper-left"),
  ]);
}

function terminalIcon(j: RowJsx, s: RowJsxs) {
  return lucideIcon(j, s, "square-terminal", [
    j("path", { d: "m7 11 2-2-2-2" }, "prompt"),
    j("path", { d: "M11 13h4" }, "cursor"),
    j("rect", { width: 18, height: 18, x: 3, y: 3, rx: 2, ry: 2 }, "frame"),
  ]);
}

function lucideIcon(j: RowJsx, s: RowJsxs, name: string, children: ReturnType<RowJsx>[]) {
  return s("svg", {
    "aria-hidden": "true",
    className: `lucide lucide-${name} size-3.5`,
    fill: "none",
    height: 24,
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeWidth: 2,
    viewBox: "0 0 24 24",
    width: 24,
    children,
  });
}
