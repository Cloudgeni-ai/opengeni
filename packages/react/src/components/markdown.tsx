import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/cn";

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
};

/* --- element renderers (themed to og-* tokens) ------------------------------ */

const components: Components = {
  h1: ({ children, ...props }) => (
    <h1 className="mt-5 mb-2.5 text-xl font-semibold tracking-tight text-og-fg first:mt-0" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="mt-5 mb-2 text-lg font-semibold tracking-tight text-og-fg first:mt-0" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="mt-4 mb-1.5 text-og-md font-semibold tracking-tight text-og-fg first:mt-0" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="mt-4 mb-1.5 text-og-sm font-semibold uppercase tracking-[0.04em] text-og-fg-muted first:mt-0" {...props}>
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
    <ul className="my-2.5 ml-5 flex list-disc flex-col gap-1 marker:text-og-fg-subtle first:mt-0 last:mb-0" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="my-2.5 ml-5 flex list-decimal flex-col gap-1 marker:text-og-fg-subtle first:mt-0 last:mb-0" {...props}>
      {children}
    </ol>
  ),
  // GFM task-list items carry a leading checkbox <input>; `list-none` + a
  // negative margin pull the checkbox back to the bullet column so it aligns
  // with the text.
  li: ({ children, ...props }) => (
    <li className="leading-7 marker:text-og-fg-subtle [&>ul]:my-1 [&>ol]:my-1 [&:has(>input)]:list-none [&:has(>input)]:-ml-5" {...props}>
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
  // Fenced code blocks — mirror the timeline's PayloadBlock <pre> styling for
  // visual consistency (bordered, scrollable, mono, surface background).
  pre: ({ children, ...props }) => (
    <pre
      className="my-3 max-h-96 overflow-auto rounded-og-md border border-og-border bg-og-bg/60 p-3 font-og-mono text-og-sm text-og-fg-muted [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit first:mt-0 last:mb-0"
      {...props}
    >
      {children}
    </pre>
  ),
  table: ({ children, ...props }) => (
    <div className="my-3 max-w-full overflow-x-auto rounded-og-md border border-og-border first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-og-base" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => (
    <thead className="bg-og-surface-1" {...props}>
      {children}
    </thead>
  ),
  th: ({ children, ...props }) => (
    <th className="border-b border-og-border px-3 py-1.5 text-left font-medium text-og-fg" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="border-b border-og-border px-3 py-1.5 align-top text-og-fg-muted [tr:last-child>&]:border-b-0" {...props}>
      {children}
    </td>
  ),
  img: ({ alt, ...props }) => <img alt={alt ?? ""} className="my-3 max-w-full rounded-og-md border border-og-border" {...props} />,
};

function MarkdownImpl({ children, className }: MarkdownProps) {
  return (
    // `min-w-0` lets the prose shrink inside flex parents (message bubbles) so
    // long links and code blocks wrap/scroll instead of forcing overflow.
    <div className={cn("min-w-0 break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Memoized so streaming re-renders of the parent don't re-parse settled bodies. */
export const Markdown = memo(MarkdownImpl);
