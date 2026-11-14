import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { registerDom, renderComponent } from "../../react/test/render-hook";
import { webColorsDark, webColorsLight } from "../src/ui/web-tokens.gen";

type TextProps = {
  children?: ReactNode;
  style?: unknown;
  accessibilityRole?: string;
  onPress?: () => void;
  onPressIn?: () => void;
  onPressOut?: () => void;
};
type LinkNode = { key: string; attributes: { href: string } };
type LinkRule = (
  node: LinkNode,
  children: ReactNode,
  parent: unknown[],
  styles: Record<string, unknown>,
  onLinkPress?: (url: string) => boolean,
) => ReactElement;

function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === "object" ? (style as Record<string, unknown>) : {};
}

// A Text that exposes its flattened style, role and press handlers to the DOM.
function Text({ children, style, accessibilityRole, onPress, onPressIn, onPressOut }: TextProps) {
  return createElement(
    "span",
    {
      "data-style": JSON.stringify(flatten(style)),
      role: accessibilityRole,
      onClick: onPress,
      onMouseDown: onPressIn,
      onMouseUp: onPressOut,
    },
    children,
  );
}

type MarkdownProps = {
  rules: Record<string, LinkRule>;
  style: Record<string, unknown>;
  onLinkPress?: (url: string) => boolean;
};
let rendered: MarkdownProps | undefined;
const rendererPath = Bun.resolveSync(
  "react-native-markdown-display/src/lib/parser.js",
  import.meta.dir,
);
const parserPath = Bun.resolveSync("markdown-it", rendererPath);
const { default: MarkdownIt } = await import(parserPath);
mock.module("react-native-markdown-display", () => ({
  MarkdownIt,
  // The library's own link rule: a pressable Text in the link style.
  renderRules: {
    link: (
      node: LinkNode,
      children: ReactNode,
      _parent: unknown[],
      styles: Record<string, unknown>,
      onLinkPress?: (url: string) => boolean,
    ) =>
      createElement(
        Text,
        { key: node.key, style: styles.link, onPress: () => onLinkPress?.(node.attributes.href) },
        children,
      ),
  },
  default: (props: MarkdownProps) => {
    rendered = props;
    return null;
  },
}));
const host =
  (tag: string) =>
  ({ children }: { children?: ReactNode }) =>
    createElement(tag, null, children);
mock.module("react-native", () => ({
  View: host("div"),
  Text,
  ScrollView: host("div"),
  Image: host("img"),
  Pressable: host("button"),
  Platform: { OS: "ios", select: (options: Record<string, unknown>) => options.ios },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));
mock.module("react-native-svg", () => ({
  default: host("svg"),
  Defs: host("defs"),
  LinearGradient: host("linearGradient"),
  Rect: host("rect"),
  Stop: host("stop"),
  Path: host("path"),
  Circle: host("circle"),
  Line: host("line"),
  Polyline: host("polyline"),
}));
mock.module("../src/timeline/markdown-math", () => ({
  DisplayMath: () => null,
  InlineMath: () => null,
}));
mock.module("../src/timeline/interactive-answer", () => ({ NativeInteractiveAnswer: () => null }));
mock.module("../src/timeline/primitives", () => ({
  withAlpha: (color: string, alpha: number) => `${color} @ ${alpha}`,
  useReleaseFollow: () => () => {},
}));

registerDom();
const { createWebMarkdownRenderer, webMarkdownStyles } = await import("../src/timeline/markdown");
const { createNativeTimelineTheme, NativeTimelineThemeProvider } =
  await import("../src/timeline/theme");

function styleOf(element: Element): Record<string, unknown> {
  return JSON.parse(element.getAttribute("data-style") ?? "{}") as Record<string, unknown>;
}

describe("native Markdown links are recognisable", () => {
  test("links take the link color and an underline in both themes", () => {
    for (const scheme of ["light", "dark"] as const) {
      const theme = createNativeTimelineTheme(scheme);
      for (const tone of ["body", "muted"] as const) {
        const link = webMarkdownStyles(theme, tone).link!;
        expect(link.color).toBe(theme.colors.link);
        expect(link.color).not.toBe(webMarkdownStyles(theme, tone).body!.color);
        expect(link.textDecorationLine).toBe("underline");
        expect(link.textDecorationColor).toBe(`${theme.colors.link} @ 0.55`);
      }
    }
  });

  test("a host's link color override reaches the link style", () => {
    const theme = createNativeTimelineTheme("dark", { dark: { link: "rgb(1, 2, 3)" } });
    expect(webMarkdownStyles(theme, "body").link!.color).toBe("rgb(1, 2, 3)");
  });

  test("a link is announced as a link, washes while pressed and opens through the host", async () => {
    const pressed: string[] = [];
    const render = createWebMarkdownRenderer({ onLinkPress: (url) => (pressed.push(url), false) });
    const theme = createNativeTimelineTheme("dark");
    rendered = undefined;
    const shell = await renderComponent(
      <NativeTimelineThemeProvider scheme="dark">
        {render("[Open report](https://example.com/report)", { tone: "body" })}
      </NativeTimelineThemeProvider>,
    );
    const { rules, style, onLinkPress } = rendered!;
    const node = { key: "link-1", attributes: { href: "https://example.com/report" } };
    const view = await renderComponent(
      <NativeTimelineThemeProvider scheme="dark">
        {rules.link!(node, "Open report", [], style, onLinkPress)}
      </NativeTimelineThemeProvider>,
    );
    const link = view.container.querySelector("span")!;
    expect(link.getAttribute("role")).toBe("link");
    expect(styleOf(link).color).toBe(theme.colors.link);
    expect(styleOf(link).textDecorationLine).toBe("underline");
    expect(styleOf(link).backgroundColor).toBeUndefined();
    await act(async () => {
      link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(styleOf(view.container.querySelector("span")!).backgroundColor).toBe(
      `${theme.colors.link} @ 0.18`,
    );
    await act(async () => {
      link.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      link.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(styleOf(view.container.querySelector("span")!).backgroundColor).toBeUndefined();
    expect(pressed).toEqual(["https://example.com/report"]);
    await view.unmount();
    await shell.unmount();
  });
});

describe("the native link token matches the web stylesheet", () => {
  const tokens = readFileSync(join(import.meta.dir, "../../react/styles/tokens.css"), "utf8");
  const declared = Array.from(
    tokens.matchAll(/--og-color-link:\s*(#[0-9a-f]{6});/gi),
    (m) => m[1]!,
  );
  const rgb = (hex: string) =>
    `rgb(${[1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16)).join(", ")})`;

  test("dark (:root) and light values are the generated native values", () => {
    expect(declared.map(rgb)).toEqual([webColorsDark.link, webColorsLight.link]);
  });

  test("links keep 4.5:1 on every chat surface in both themes", () => {
    const channels = (color: string) => color.match(/\d+/g)!.slice(0, 3).map(Number);
    const luminance = (color: string) => {
      const [r, g, b] = channels(color).map((value) => {
        const s = value / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (a: string, b: string) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (high! + 0.05) / (low! + 0.05);
    };
    for (const colors of [webColorsDark, webColorsLight]) {
      for (const surface of ["canvas", "bg", "surface-1", "surface-2", "surface-3"] as const) {
        expect(contrast(colors.link, colors[surface])).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
