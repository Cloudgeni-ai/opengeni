import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Image, Pressable, ScrollView, Text, View, type TextStyle } from "react-native";
import Markdown, { MarkdownIt, renderRules, type RenderRules } from "react-native-markdown-display";
import {
  isReservedOpenGeniLink,
  parseOpenGeniLink,
  parseRetainedFileReference,
  type OpenGeniLinkTarget,
} from "@opengeni/sdk";
import {
  interactivePreviewKind,
  type InteractivePreviewKind,
} from "@opengeni/react/native-previews";
import { Icon } from "./icon";
import { withAlpha as withAlphaColor } from "./primitives";
import type { NativeMarkdownRenderer } from "./message-timeline";
import {
  fontStyle,
  insetSurface,
  MONO_FALLBACK,
  useNativeTimelineTheme,
  type NativeTimelineTheme,
} from "./theme";

/**
 * One parser for every message, configured like the web's `remark-gfm`: no typographic
 * substitution (quotes, dashes and `(c)` stay as written), and bare `http(s)://` URLs
 * autolink while file-like words (`fib.py`) do not. The library default would build a
 * new typographer parser on every render, including every streaming delta.
 */
const PARSER = (() => {
  const parser = MarkdownIt({ typographer: false, linkify: true });
  parser.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
  return parser;
})();

/* ----------------------------------------------------------------------------
   Web Markdown (components/markdown.tsx) styles for react-native-markdown-display.
   Prose 15/28 (`text-og-md leading-7`), paragraphs `my-2.5`, lists `ml-5 gap-1`,
   code blocks `rounded-og-md bg-surface-1/70 px-3 py-2.5 text-og-sm leading-5`.
   -------------------------------------------------------------------------- */

export function webMarkdownStyles(
  theme: NativeTimelineTheme,
  tone: "body" | "muted",
): Record<string, TextStyle> {
  const c = theme.colors;
  const muted = tone === "muted";
  const size = muted ? theme.size.base : theme.size.md;
  const line = muted ? 24 : 28;
  const body = {
    ...fontStyle(theme),
    color: muted ? c["fg-muted"] : c.fg,
    fontSize: size,
    lineHeight: line,
  };
  const mono = fontStyle(theme, 400, "mono");
  const heading = { ...fontStyle(theme, 600), color: c.fg, letterSpacing: -0.2 };
  return {
    body,
    paragraph: { marginTop: 0, marginBottom: 10 },
    // Web margins collapse against the 10pt paragraph margin; native margins add up.
    heading1: { ...heading, fontSize: 20, lineHeight: 28, marginTop: 10, marginBottom: 10 },
    heading2: { ...heading, fontSize: 18, lineHeight: 26, marginTop: 10, marginBottom: 8 },
    heading3: {
      ...heading,
      fontSize: theme.size.md,
      lineHeight: 24,
      marginTop: 6,
      marginBottom: 6,
    },
    heading4: {
      ...heading,
      fontSize: theme.size.sm,
      lineHeight: 18,
      marginTop: 6,
      marginBottom: 6,
      textTransform: "uppercase" as const,
    },
    strong: { ...fontStyle(theme, 600), color: muted ? c["fg-muted"] : c.fg },
    em: theme.fonts.sansItalic
      ? { fontFamily: theme.fonts.sansItalic }
      : { fontStyle: "italic" as const },
    bullet_list: { marginTop: 0, marginBottom: 10 },
    ordered_list: { marginTop: 0, marginBottom: 10 },
    list_item: { marginBottom: 4 },
    bullet_list_icon: { color: c["fg-subtle"], marginLeft: 6, marginRight: 8, lineHeight: line },
    ordered_list_icon: { color: c["fg-subtle"], marginLeft: 2, marginRight: 6, lineHeight: line },
    code_inline: {
      ...mono,
      fontFamily: (mono.fontFamily as string | undefined) ?? MONO_FALLBACK,
      fontSize: theme.size.sm,
      backgroundColor: c["surface-2"],
      color: c.fg,
      borderRadius: theme.radius.xs,
      paddingHorizontal: 4,
      borderWidth: 0,
    },
    fence: {
      ...mono,
      fontSize: theme.size.sm,
      lineHeight: 20,
      color: c["fg-muted"],
      backgroundColor: insetSurface(theme),
      borderWidth: 0,
      borderRadius: theme.radius.md,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginTop: 2,
      marginBottom: 10,
    },
    code_block: {
      ...mono,
      fontSize: theme.size.sm,
      lineHeight: 20,
      color: c["fg-muted"],
      backgroundColor: insetSurface(theme),
      borderWidth: 0,
      borderRadius: theme.radius.md,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    // Web MARKDOWN_LINK_CLASS: medium weight in accent-strong, no underline.
    link: {
      ...fontStyle(theme, 500),
      color: c["accent-strong"],
      textDecorationLine: "none" as const,
    },
    blockquote: {
      // Web blockquote text is fg-muted; text styles inherit through the renderer.
      color: c["fg-muted"],
      backgroundColor: "transparent",
      borderLeftColor: c["border-strong"],
      borderLeftWidth: 2,
      paddingLeft: 14,
      marginLeft: 0,
      marginVertical: 12,
    },
    hr: { backgroundColor: c.border, height: 1, marginVertical: 16 },
    // Web tables: unboxed, text-og-base, hairline rules, content-sized columns.
    table: { borderWidth: 0, marginTop: 12, marginBottom: 10 },
    thead: {},
    th: {
      ...fontStyle(theme, 500),
      color: c.fg,
      fontSize: theme.size.base,
      lineHeight: 20,
      paddingVertical: 6,
      paddingRight: 16,
    },
    tr: { borderBottomWidth: 0 },
    td: {
      color: c["fg-muted"],
      fontSize: theme.size.base,
      lineHeight: 20,
      paddingVertical: 6,
      paddingRight: 16,
    },
  };
}

function CodeFence({
  content,
  language,
  onCopy,
}: {
  content: string;
  language: string;
  onCopy?: ((text: string) => void) | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const styles = webMarkdownStyles(theme, "body");
  const [copied, setCopied] = useState(false);
  // The code scrolls in the space left of the language label and copy button, which
  // vary in width ("SH" vs "TYPESCRIPT"); reserve their measured width plus a gap.
  const [chromeWidth, setChromeWidth] = useState(64);
  return (
    <View style={{ marginTop: 2, marginBottom: 10 }}>
      <View
        style={{
          borderRadius: theme.radius.md,
          backgroundColor: insetSurface(theme),
          paddingLeft: 12,
          paddingRight: chromeWidth,
          paddingVertical: 10,
        }}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text
            selectable
            style={{
              ...styles.code_block,
              backgroundColor: "transparent",
              paddingHorizontal: 0,
              paddingVertical: 0,
            }}
          >
            {content}
          </Text>
        </ScrollView>
      </View>
      <View
        onLayout={(event) => {
          const next = Math.ceil(event.nativeEvent.layout.width) + 6 + 10;
          if (next !== chromeWidth) setChromeWidth(next);
        }}
        style={{
          position: "absolute",
          top: 6,
          right: 6,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
        }}
      >
        {language ? (
          <Text
            style={{
              ...fontStyle(theme, 400, "mono"),
              fontSize: 10,
              letterSpacing: 0.5,
              textTransform: "uppercase",
              color: theme.colors["fg-subtle"],
              opacity: 0.7,
            }}
          >
            {language}
          </Text>
        ) : null}
        {onCopy ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy code"
            hitSlop={8}
            onPress={() => {
              onCopy(content);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
            style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
          >
            <Icon name={copied ? "check" : "copy"} size={14} color={theme.colors["fg-subtle"]} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/* Tables ------------------------------------------------------------------- */

type AstNode = { type: string; content?: string; children?: AstNode[] };

function astText(node: AstNode): string {
  // Container nodes carry an empty content string; text lives in their leaves.
  if (node.children && node.children.length > 0) return node.children.map(astText).join("");
  return typeof node.content === "string" ? node.content : "";
}

function tableRows(table: AstNode): string[][] {
  const rows: string[][] = [];
  const visit = (node: AstNode) => {
    if (node.type === "tr") rows.push((node.children ?? []).map((cell) => astText(cell).trim()));
    else (node.children ?? []).forEach(visit);
  };
  visit(table);
  return rows;
}

/**
 * Content-sized columns, as a browser's auto table layout lays them out: short
 * columns keep their natural width on one line, long ones share the rest.
 */
function tableColumns(rows: string[][]): { width?: number; grow: number }[] {
  const count = Math.max(0, ...rows.map((row) => row.length));
  return Array.from({ length: count }, (_, index) => {
    const longest = Math.max(1, ...rows.map((row) => row[index]?.length ?? 0));
    return longest <= 14 ? { width: Math.ceil(longest * 8.4) + 20, grow: 0 } : { grow: longest };
  });
}

/** A cell's column: its sibling index in the row (set by the AST builder). */
function cellIndex(node: { index?: unknown }): number {
  return typeof node.index === "number" && node.index >= 0 ? node.index : 0;
}

/** Explicit column widths for a measured table; empty until the table lays out. */
const TableColumnsContext = createContext<number[]>([]);

function columnWidths(columns: { width?: number; grow: number }[], available: number): number[] {
  const fixed = columns.reduce((sum, column) => sum + (column.width ?? 0), 0);
  const growth = columns.reduce(
    (sum, column) => sum + (column.width === undefined ? column.grow : 0),
    0,
  );
  const rest = Math.max(0, available - fixed);
  if (growth === 0) return columns.map((column) => column.width ?? 0);
  // Long columns share the rest by length, each keeping a readable minimum.
  return columns.map((column) =>
    column.width !== undefined ? column.width : Math.max(64, (rest * column.grow) / growth),
  );
}

/** A column's comfortable width when the table is wider than the screen. */
function naturalColumnWidth(column: { width?: number; grow: number }): number {
  return column.width ?? Math.min(280, Math.max(120, Math.ceil(column.grow * 7.6) + 20));
}

function MarkdownTable({
  node,
  children,
  onCopy,
}: {
  node: AstNode;
  children: ReactNode;
  onCopy?: ((text: string) => void) | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const rows = useMemo(() => tableRows(node), [node]);
  const columns = useMemo(() => tableColumns(rows), [rows]);
  const natural = useMemo(() => columns.map(naturalColumnWidth), [columns]);
  const naturalWidth = natural.reduce((sum, width) => sum + width, 0);
  const [available, setAvailable] = useState(0);
  // Web wraps tables in overflow-x-auto: a table that cannot fit keeps readable
  // columns and scrolls sideways instead of crushing every cell.
  const scrolls = available > 0 && naturalWidth > available;
  const widths = useMemo(
    () => (available > 0 ? (scrolls ? natural : columnWidths(columns, available)) : []),
    [available, columns, natural, scrolls],
  );
  const [copied, setCopied] = useState(false);
  const body = (
    <TableColumnsContext.Provider value={widths}>{children}</TableColumnsContext.Provider>
  );
  return (
    <View
      style={{ marginTop: 12, marginBottom: 10 }}
      onLayout={(event) => setAvailable(Math.round(event.nativeEvent.layout.width))}
    >
      {scrolls ? (
        <ScrollView
          horizontal
          nestedScrollEnabled
          directionalLockEnabled
          showsHorizontalScrollIndicator
          accessibilityHint="Scroll sideways to see every column"
        >
          <View style={{ width: naturalWidth }}>{body}</View>
        </ScrollView>
      ) : (
        body
      )}
      {onCopy ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy table"
          hitSlop={8}
          onPress={() => {
            onCopy(rows.map((row) => row.join("\t")).join("\n"));
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          style={{
            position: "absolute",
            top: 2,
            right: 0,
            width: 28,
            height: 28,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 8,
            backgroundColor: scrolls ? theme.colors.bg : "transparent",
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={14} color={theme.colors["fg-subtle"]} />
        </Pressable>
      ) : null}
    </View>
  );
}

function TableRow({ head, last, children }: { head: boolean; last: boolean; children: ReactNode }) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  return (
    <View
      style={{
        flexDirection: "row",
        borderBottomWidth: last ? 0 : 1,
        // Header rule in border; body rules at 70% (web border-og-border/70).
        borderBottomColor: head ? c.border : withAlphaColor(c.border, 0.7),
      }}
    >
      {children}
    </View>
  );
}

function TableCell({
  index,
  style,
  children,
}: {
  index: number;
  style: object;
  children: ReactNode;
}) {
  const width = useContext(TableColumnsContext)[index];
  return (
    <View
      style={[
        style,
        // The renderer's default cell style is flex: 1 (equal columns); a measured
        // table replaces it with content-sized widths.
        width !== undefined ? { flex: 0, width } : null,
      ]}
    >
      {children}
    </View>
  );
}

function webRules(
  theme: NativeTimelineTheme,
  tone: "body" | "muted",
  onCopy?: (text: string) => void,
  media: MarkdownMediaOptions = {},
): RenderRules {
  const line = tone === "muted" ? 24 : 28;
  return {
    ...renderRules,
    // Web lists use a disc marker in fg-subtle; the library's iOS default is a middle dot.
    list_item: (node, children, parent, styles, inheritedStyles = {}) => {
      if (parent.some((entry: { type: string }) => entry.type === "bullet_list")) {
        // A drawn disc: the text bullet glyph renders noticeably smaller than
        // the browser's list-disc marker at the same line height.
        const disc = 5.5;
        return (
          <View key={node.key} style={{ flexDirection: "row", marginBottom: 4 }}>
            <View
              accessible={false}
              style={{ width: 20, height: line, alignItems: "center", justifyContent: "center" }}
            >
              <View
                style={{
                  width: disc,
                  height: disc,
                  borderRadius: disc / 2,
                  backgroundColor: theme.colors["fg-subtle"],
                }}
              />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>{children}</View>
          </View>
        );
      }
      return renderRules.list_item!(node, children, parent, styles, inheritedStyles);
    },
    table: (node, children) => (
      <MarkdownTable key={node.key} node={node} onCopy={onCopy}>
        {children}
      </MarkdownTable>
    ),
    tr: (node, children, parent) => {
      const head = parent.some((entry: { type: string }) => entry.type === "thead");
      const body = parent.find((entry: { type: string }) => entry.type === "tbody") as
        | { children?: unknown[] }
        | undefined;
      const last = !head && body?.children?.[body.children.length - 1] === node;
      return (
        <TableRow key={node.key} head={head} last={last}>
          {children}
        </TableRow>
      );
    },
    th: (node, children, _parent, styles) => (
      <TableCell key={node.key} index={cellIndex(node)} style={styles._VIEW_SAFE_th}>
        {children}
      </TableCell>
    ),
    td: (node, children, _parent, styles) => (
      <TableCell key={node.key} index={cellIndex(node)} style={styles._VIEW_SAFE_td}>
        {children}
      </TableCell>
    ),
    fence: (node) => {
      const raw = typeof node.content === "string" ? node.content : "";
      const content = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
      const info = (node as { sourceInfo?: unknown }).sourceInfo;
      const language = typeof info === "string" ? (info.trim().split(/\s+/)[0] ?? "") : "";
      const kind = interactivePreviewKind(language);
      if (kind && media.renderInteractiveBlock) {
        return (
          <InteractiveFence
            key={node.key}
            kind={kind}
            content={content}
            render={media.renderInteractiveBlock}
          />
        );
      }
      return <CodeFence key={node.key} content={content} language={language} onCopy={onCopy} />;
    },
    image: (node) => {
      const attributes = (node as { attributes?: { src?: unknown; alt?: unknown } }).attributes;
      const src = typeof attributes?.src === "string" ? attributes.src : "";
      const alt = typeof attributes?.alt === "string" ? attributes.alt : "";
      const custom = src ? media.renderImage?.({ src, alt }) : undefined;
      return custom !== undefined && custom !== null ? (
        <View key={node.key}>{custom}</View>
      ) : (
        <MarkdownImage key={node.key} src={src} alt={alt} />
      );
    },
  };
}

/** An assistant-authored interactive preview fence, as the host should draw it. */
export type NativeInteractiveBlock = {
  kind: InteractivePreviewKind;
  /** The fence body (complete only when `state` is "complete"). */
  content: string;
  /**
   * "streaming": still being written (show a loading surface, never the body);
   * "incomplete": generation stopped before the fence closed; "complete".
   */
  state: "streaming" | "incomplete" | "complete";
};

export interface MarkdownMediaOptions {
  /**
   * Draw a Markdown image. Retained files arrive as `artifact:<id>` sources,
   * which only the host can resolve; return null to use the built-in image.
   */
  renderImage?: ((image: { src: string; alt: string }) => ReactNode) | undefined;
  /**
   * Draw `opengeni-html` / `opengeni-site` fences (web `renderInteractiveBlock`).
   * Without it they show as code, like the web without the host opt-in.
   */
  renderInteractiveBlock?: ((block: NativeInteractiveBlock) => ReactNode) | undefined;
}

/** Whether the message ends inside an unclosed fence, and that fence's body. */
export function trailingOpenFence(text: string): string | null {
  let open: { char: string; length: number; lines: string[] } | null = null;
  for (const line of text.split("\n")) {
    if (open) {
      const close = /^ {0,3}([`~]{3,})\s*$/.exec(line);
      if (close && close[1]![0] === open.char && close[1]!.length >= open.length) open = null;
      else open.lines.push(line);
      continue;
    }
    const start = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (start) open = { char: start[1]![0]!, length: start[1]!.length, lines: [] };
  }
  return open ? open.lines.join("\n") : null;
}

const FenceStateContext = createContext<{ openTail: string | null; streaming: boolean }>({
  openTail: null,
  streaming: false,
});

function InteractiveFence({
  kind,
  content,
  render,
}: {
  kind: InteractivePreviewKind;
  content: string;
  render: (block: NativeInteractiveBlock) => ReactNode;
}) {
  const { openTail, streaming } = useContext(FenceStateContext);
  const open = openTail !== null && openTail.trimEnd() === content.trimEnd();
  const state = !open ? "complete" : streaming ? "streaming" : "incomplete";
  return <>{render({ kind, content: state === "complete" ? content : "", state })}</>;
}

/** Plain image URLs load directly; retained files need the host's `renderImage`. */
function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const theme = useNativeTimelineTheme();
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const remote = /^https?:\/\//i.test(src) && !parseRetainedFileReference(src);
  if (!remote || failed) {
    return (
      <Text
        style={{ ...fontStyle(theme), color: theme.colors["fg-muted"], fontSize: theme.size.sm }}
      >
        {alt || "Image"} (preview unavailable)
      </Text>
    );
  }
  return (
    <Image
      accessibilityLabel={alt || "Image"}
      source={{ uri: src }}
      resizeMode="contain"
      onLoad={(event) => {
        const { width, height } = event.nativeEvent.source;
        if (width > 0 && height > 0) setRatio(width / height);
      }}
      onError={() => setFailed(true)}
      style={{
        width: "100%",
        aspectRatio: ratio ?? 4 / 3,
        maxHeight: 420,
        marginVertical: 8,
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors["surface-2"],
      }}
    />
  );
}

/** Trim the trailing paragraph margin (web `last:mb-0`). */
function TrimmedMarkdown({
  text,
  tone,
  streaming,
  onLinkPress,
  onCopy,
  media,
}: {
  text: string;
  tone: "body" | "muted";
  streaming: boolean;
  onLinkPress?: ((url: string) => boolean) | undefined;
  onCopy?: ((text: string) => void) | undefined;
  media: MarkdownMediaOptions;
}) {
  const theme = useNativeTimelineTheme();
  const styles = useMemo(() => webMarkdownStyles(theme, tone), [theme, tone]);
  const rules = useMemo(() => webRules(theme, tone, onCopy, media), [theme, tone, onCopy, media]);
  const openTail = useMemo(
    () => (media.renderInteractiveBlock ? trailingOpenFence(text) : null),
    [media.renderInteractiveBlock, text],
  );
  const fenceState = useMemo(() => ({ openTail, streaming }), [openTail, streaming]);
  return (
    <View style={{ marginBottom: -10 }}>
      <FenceStateContext.Provider value={fenceState}>
        <Markdown
          markdownit={PARSER}
          style={styles}
          rules={rules}
          {...(onLinkPress ? { onLinkPress } : {})}
        >
          {text}
        </Markdown>
      </FenceStateContext.Provider>
    </View>
  );
}

export function createWebMarkdownRenderer(
  options: {
    onLinkPress?: (url: string) => boolean;
    onCopy?: (text: string) => void;
    /** Opengeni links (sandbox files, artifacts, Sites); never handed to the OS. */
    onOpenGeniLink?: (target: OpenGeniLinkTarget) => void;
  } & MarkdownMediaOptions = {},
): NativeMarkdownRenderer {
  const onLinkPress = (url: string): boolean => {
    const target = parseOpenGeniLink(url);
    if (target || isReservedOpenGeniLink(url)) {
      if (target) options.onOpenGeniLink?.(target);
      return false;
    }
    return options.onLinkPress ? options.onLinkPress(url) : true;
  };
  // One stable object, so the memoized rules survive every streaming delta.
  const media: MarkdownMediaOptions = {
    renderImage: options.renderImage,
    renderInteractiveBlock: options.renderInteractiveBlock,
  };
  return (text, { tone, streaming }): ReactNode =>
    text.trim() ? (
      <TrimmedMarkdown
        text={text}
        tone={tone}
        streaming={streaming === true}
        onLinkPress={onLinkPress}
        onCopy={options.onCopy}
        media={media}
      />
    ) : (
      <Text />
    );
}
