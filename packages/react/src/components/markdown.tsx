import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useReducer,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/cn";
import { tableElementToTsv } from "../lib/clipboard";
import { prefersReducedMotion } from "../lib/motion";
import { CopyButton } from "./copy-button";
import { softenStreamingMarkdown } from "./soften-streaming-markdown";
import { createStreamReveal, rehypeStreamReveal, type StreamReveal } from "./stream-reveal";

/**
 * The default renderer for chat message bodies in {@link MessageTimeline}.
 *
 * Agent (and user) messages arrive as GitHub-flavored markdown. This turns the
 * raw text into styled HTML using `react-markdown` + `remark-gfm`, themed to the
 * package's `og-*` design tokens so it reads as one cohesive dark surface — no
 * stock Tailwind colors leak in.
 *
 * It re-parses on every render, which is exactly right for streaming: a body
 * that is still arriving (an unterminated `**`, a half-open code fence, a table
 * mid-row) renders as best-effort markdown and resolves cleanly as the rest of
 * the tokens land. Consumers who want a different renderer can still pass
 * `renderMessageText` to `MessageTimeline` to override this entirely.
 */
export type MarkdownProps = {
  children: string;
  className?: string | undefined;
  /**
   * While true, newly arrived source fades in through tip ink (`.og-stream-ink`):
   * an age window over each append batch — fast streams keep a large soft band,
   * slow streams a tight tip. Paint-only: the DOM always holds the full truthful
   * text. Once streaming ends and trailing ink settles, the body re-renders as
   * plain markdown with a short local settle breath (no page-wide view
   * transition — that blinked the whole document).
   */
  streaming?: boolean | undefined;
};

/* --- element renderers (themed to og-* tokens) ------------------------------ */

const components: Components = {
  h1: ({ children, ...props }) => (
    <h1
      className="mt-5 mb-2.5 text-xl font-semibold tracking-tight text-og-fg first:mt-0"
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="mt-5 mb-2 text-lg font-semibold tracking-tight text-og-fg first:mt-0" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3
      className="mt-4 mb-1.5 text-og-md font-semibold tracking-tight text-og-fg first:mt-0"
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4
      className="mt-4 mb-1.5 text-og-sm font-semibold uppercase tracking-[0.04em] text-og-fg-muted first:mt-0"
      {...props}
    >
      {children}
    </h4>
  ),
  p: ({ children, ...props }) => (
    <p className="my-2.5 leading-7 first:mt-0 last:mb-0" {...props}>
      {children}
    </p>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-semibold text-og-fg" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic" {...props}>
      {children}
    </em>
  ),
  a: ({ children, ...props }) => (
    <a
      className="break-words font-medium text-og-accent underline-offset-2 hover:underline"
      target="_blank"
      rel="noreferrer noopener"
      {...props}
    >
      {children}
    </a>
  ),
  ul: ({ children, ...props }) => (
    <ul
      className="my-2.5 ml-5 flex list-disc flex-col gap-1 marker:text-og-fg-subtle first:mt-0 last:mb-0"
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol
      className="my-2.5 ml-5 flex list-decimal flex-col gap-1 marker:text-og-fg-subtle first:mt-0 last:mb-0"
      {...props}
    >
      {children}
    </ol>
  ),
  // GFM task-list items carry a leading checkbox <input>; `list-none` + a
  // negative margin pull the checkbox back to the bullet column so it aligns
  // with the text.
  li: ({ children, ...props }) => (
    <li
      className="leading-7 marker:text-og-fg-subtle [&>ul]:my-1 [&>ol]:my-1 [&:has(>input)]:list-none [&:has(>input)]:-ml-5"
      {...props}
    >
      {children}
    </li>
  ),
  input: ({ type, ...props }) =>
    type === "checkbox" ? (
      <input
        {...props}
        type="checkbox"
        disabled
        className="mr-2 size-3.5 translate-y-[2px] cursor-default accent-og-accent align-baseline"
      />
    ) : (
      <input type={type} {...props} />
    ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="my-3 border-l-2 border-og-border-strong pl-3.5 text-og-fg-muted [&>p]:my-1.5 first:mt-0 last:mb-0"
      {...props}
    >
      {children}
    </blockquote>
  ),
  hr: (props) => <hr className="my-4 border-0 border-t border-og-border" {...props} />,
  // Inline `code` vs fenced code blocks. react-markdown v10 no longer passes an
  // `inline` flag; a fenced block is a <code> whose parent is <pre> (styled by
  // the `pre` renderer), so a `code` reaching here is treated as inline.
  code: ({ children, className: _className, ...props }) => (
    <code
      className="rounded-og-xs border border-og-border bg-og-surface-1 px-1 py-0.5 font-og-mono text-og-sm text-og-fg"
      {...props}
    >
      {children}
    </code>
  ),
  // Fenced code — bordered mono block with language chip + copy.
  pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
  // Tables stay unboxed (hairline rules); hover reveals a TSV copy control.
  table: ({ children, ...props }) => (
    <MarkdownTable {...props}>{children}</MarkdownTable>
  ),
  thead: ({ children, ...props }) => <thead {...props}>{children}</thead>,
  th: ({ children, ...props }) => (
    <th
      className="border-b border-og-border px-0 py-1.5 pr-4 text-left font-medium text-og-fg first:pl-0"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td
      className="border-b border-og-border/70 px-0 py-1.5 pr-4 align-top text-og-fg-muted [tr:last-child>&]:border-b-0"
      {...props}
    >
      {children}
    </td>
  ),
  img: ({ alt, ...props }) => (
    <img
      alt={alt ?? ""}
      className="my-3 max-w-full rounded-og-md border border-og-border"
      {...props}
    />
  ),
};

/** How long after the stream ends the reveal pipeline stays for trailing animations. */
const REVEAL_LINGER_MS = 900;
/** Keep in sync with `--og-duration-markdown-crystallize` / view-transition CSS. */
const MARKDOWN_SETTLE_MS = 480;

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(nodeText).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeText(node.props.children);
  }
  return "";
}

function fenceLanguage(children: ReactNode): string | null {
  let found: string | null = null;
  Children.forEach(children, (child) => {
    if (found || !isValidElement<{ className?: string }>(child)) {
      return;
    }
    const match = /language-([a-zA-Z0-9_+-]+)/.exec(child.props.className ?? "");
    if (match?.[1]) {
      found = match[1];
    }
  });
  return found;
}

function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const code = nodeText(children).replace(/\n$/, "");
  const language = fenceLanguage(children);
  return (
    <div className="group/copy relative my-3 first:mt-0 last:mb-0">
      {/* Overlay only — no reserved header row / extra vertical space. */}
      <div className="pointer-events-none absolute top-1.5 right-1.5 z-10 flex items-center gap-1">
        {language ? (
          <span className="rounded px-1 py-0.5 font-og-mono text-[10px] uppercase tracking-wide text-og-fg-subtle/80 opacity-0 transition-opacity group-hover/copy:opacity-100 pointer-coarse:opacity-70">
            {language}
          </span>
        ) : null}
        <div className="pointer-events-auto">
          <CopyButton text={code} label="Copy code" reveal="group-hover" />
        </div>
      </div>
      <pre className="max-h-96 overflow-auto rounded-og-md border border-og-border bg-og-bg/60 p-3 font-og-mono text-og-sm text-og-fg-muted [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit">
        {children}
      </pre>
    </div>
  );
}

function MarkdownTable({ children, className, ...props }: ComponentPropsWithoutRef<"table">) {
  const tableRef = useRef<HTMLTableElement | null>(null);
  return (
    <div className="group/copy relative my-3 max-w-full first:mt-0 last:mb-0">
      <div className="pointer-events-none absolute top-0 right-0 z-10">
        <div className="pointer-events-auto">
          <CopyButton
            text={() => tableElementToTsv(tableRef.current)}
            label="Copy table"
            reveal="group-hover"
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table
          ref={tableRef}
          className={cn("w-full min-w-0 border-collapse text-og-base", className)}
          {...props}
        >
          {children}
        </table>
      </div>
    </div>
  );
}

function MarkdownImpl({ children, className, streaming = false }: MarkdownProps) {
  // Tip-ink engine for THIS body: created on the first streaming render, kept
  // through a short linger after the stream ends (so the last age window can
  // finish), then dropped so settled bodies pay zero cost. Observing during
  // render is idempotent per text length — StrictMode double-renders are safe.
  const revealRef = useRef<StreamReveal | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [settling, setSettling] = useState(false);
  const hadRevealRef = useRef(false);
  const now = typeof performance !== "undefined" ? performance.now() : Date.now();

  // Local settle breath only — View Transitions with `::view-transition-*(*)`
  // were fading the document root and felt like a full-page blink / focus loss
  // right as a turn ended (just before the next user message in the seed loop).
  const crystallize = (mutate: () => void) => {
    mutate();
    setSettling(true);
    bump();
    return setTimeout(() => setSettling(false), MARKDOWN_SETTLE_MS);
  };
  if (streaming && revealRef.current === null && !prefersReducedMotion()) {
    revealRef.current = createStreamReveal();
  }
  const reveal = revealRef.current;
  if (reveal !== null && streaming) {
    reveal.observe(children, now);
  }
  if (reveal !== null) {
    hadRevealRef.current = true;
  }
  const revealActive = reveal !== null && (streaming || reveal.hasActive(now));
  // The plugin walks the standard hast tree; a structural local type keeps the
  // module dependency-free, at the cost of this narrowing cast at the seam.
  const rehypePlugins =
    revealActive && reveal !== null
      ? ([[rehypeStreamReveal, { reveal, now }]] as unknown as NonNullable<
          Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]
        >)
      : undefined;

  // Drop tip ink after trailing age windows finish. Same commit crystallizes:
  // ink spans → final plain markdown (soften off) + a short local settle breath.
  useEffect(() => {
    if (streaming || revealRef.current === null) {
      return;
    }
    let clearSettle: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      const shouldSettle = hadRevealRef.current && !prefersReducedMotion();
      if (shouldSettle) {
        hadRevealRef.current = false;
      }
      if (shouldSettle) {
        clearSettle = crystallize(() => {
          revealRef.current = null;
        });
      } else {
        revealRef.current = null;
        bump();
      }
    }, REVEAL_LINGER_MS);
    return () => {
      clearTimeout(timer);
      if (clearSettle !== undefined) {
        clearTimeout(clearSettle);
      }
    };
  }, [streaming]);

  // No-reveal path (stream ended before any ink batch): soften already dropped
  // with `streaming`; keep the same local settle breath.
  const wasStreamingRef = useRef(streaming);
  useEffect(() => {
    const ended = wasStreamingRef.current && !streaming;
    wasStreamingRef.current = streaming;
    if (!ended || revealRef.current !== null || prefersReducedMotion()) {
      return;
    }
    setSettling(true);
    const timer = setTimeout(() => setSettling(false), MARKDOWN_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [streaming]);

  // Soften unfinished markers for DISPLAY while the reveal pipeline is alive
  // (stream + linger) — not only while `streaming` — so task lists / tables /
  // fences don't snap to final GFM one commit before the crystallize morph.
  // Reveal identity still tracks the true source (`children`).
  const parseText = streaming || revealActive ? softenStreamingMarkdown(children) : children;

  return (
    // `min-w-0` lets the prose shrink inside flex parents (message bubbles) so
    // long links and code blocks wrap/scroll instead of forcing overflow.
    <div
      ref={bodyRef}
      className={cn(
        "og-markdown-body min-w-0 break-words",
        settling && "og-markdown-settle",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={components}>
        {parseText}
      </ReactMarkdown>
    </div>
  );
}

/** Memoized so streaming re-renders of the parent don't re-parse settled bodies. */
export const Markdown = memo(MarkdownImpl);
