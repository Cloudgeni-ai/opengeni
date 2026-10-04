import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Markdown, { renderRules, type RenderRules } from "react-native-markdown-display";
import { isReservedOpenGeniLink, parseOpenGeniLink, type OpenGeniLinkTarget } from "@opengeni/sdk";
import { Icon } from "./icon";
import { withAlpha as withAlphaColor } from "./primitives";
import type { NativeMarkdownRenderer } from "./message-timeline";
import {
  fontStyle,
  MONO_FALLBACK,
  useNativeTimelineTheme,
  type NativeTimelineTheme,
} from "./theme";

/* ----------------------------------------------------------------------------
   Web Markdown (components/markdown.tsx) styles for react-native-markdown-display.
   Prose 15/28 (`text-og-md leading-7`), paragraphs `my-2.5`, lists `ml-5 gap-1`,
   code blocks `rounded-og-md bg-surface-1/70 px-3 py-2.5 text-og-sm leading-5`.
   -------------------------------------------------------------------------- */

export function webMarkdownStyles(theme: NativeTimelineTheme, tone: "body" | "muted") {
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
      backgroundColor: c["surface-1"],
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
      backgroundColor: c["surface-1"],
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
  return (
    <View style={{ marginTop: 2, marginBottom: 10 }}>
      <View
        style={{
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors["surface-1"],
          paddingLeft: 12,
          paddingRight: 64,
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
  const [available, setAvailable] = useState(0);
  const widths = useMemo(
    () => (available > 0 ? columnWidths(columns, available) : []),
    [available, columns],
  );
  const [copied, setCopied] = useState(false);
  return (
    <View
      style={{ marginTop: 12, marginBottom: 10 }}
      onLayout={(event) => setAvailable(Math.round(event.nativeEvent.layout.width))}
    >
      <TableColumnsContext.Provider value={widths}>{children}</TableColumnsContext.Provider>
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
      return <CodeFence key={node.key} content={content} language={language} onCopy={onCopy} />;
    },
  };
}

/** Trim the trailing paragraph margin (web `last:mb-0`). */
function TrimmedMarkdown({
  text,
  tone,
  onLinkPress,
  onCopy,
}: {
  text: string;
  tone: "body" | "muted";
  onLinkPress?: ((url: string) => boolean) | undefined;
  onCopy?: ((text: string) => void) | undefined;
}) {
  const theme = useNativeTimelineTheme();
  const styles = useMemo(() => webMarkdownStyles(theme, tone), [theme, tone]);
  const rules = useMemo(() => webRules(theme, tone, onCopy), [theme, tone, onCopy]);
  return (
    <View style={{ marginBottom: -10 }}>
      <Markdown style={styles} rules={rules} {...(onLinkPress ? { onLinkPress } : {})}>
        {text}
      </Markdown>
    </View>
  );
}

export function createWebMarkdownRenderer(
  options: {
    onLinkPress?: (url: string) => boolean;
    onCopy?: (text: string) => void;
    /** OpenGeni links (sandbox files, artifacts, Sites); never handed to the OS. */
    onOpenGeniLink?: (target: OpenGeniLinkTarget) => void;
  } = {},
): NativeMarkdownRenderer {
  const onLinkPress = (url: string): boolean => {
    const target = parseOpenGeniLink(url);
    if (target || isReservedOpenGeniLink(url)) {
      if (target) options.onOpenGeniLink?.(target);
      return false;
    }
    return options.onLinkPress ? options.onLinkPress(url) : true;
  };
  return (text, { tone }): ReactNode =>
    text.trim() ? (
      <TrimmedMarkdown text={text} tone={tone} onLinkPress={onLinkPress} onCopy={options.onCopy} />
    ) : (
      <Text />
    );
}
