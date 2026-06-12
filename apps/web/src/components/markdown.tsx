import { cn } from "@/lib/utils";
import { Streamdown, type StreamdownComponents } from "../vendor/streamdown-runtime.js";

export function MarkdownText({ text, compact = false, streaming = false }: { text: string; compact?: boolean; streaming?: boolean }) {
  return (
    <Streamdown
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      controls={{
        table: { copy: true, download: false, fullscreen: false },
        code: { copy: true, download: false },
        mermaid: false,
      }}
      components={markdownComponents}
      className={cn("markdown-stream", compact && "markdown-stream-compact")}
    >
      {text}
    </Streamdown>
  );
}

const markdownComponents: StreamdownComponents = {
  p: ({ className, ...props }) => <p className={cn("my-1.5 first:mt-0 last:mb-0", className)} {...props} />,
  h1: ({ className, ...props }) => <h1 className={cn("mb-2 mt-4 text-xl font-semibold leading-7 first:mt-0", className)} {...props} />,
  h2: ({ className, ...props }) => <h2 className={cn("mb-2 mt-4 text-lg font-semibold leading-7 first:mt-0", className)} {...props} />,
  h3: ({ className, ...props }) => <h3 className={cn("mb-1.5 mt-3 text-base font-semibold leading-6 first:mt-0", className)} {...props} />,
  h4: ({ className, ...props }) => <h4 className={cn("mb-1 mt-3 text-sm font-semibold leading-6 first:mt-0", className)} {...props} />,
  ul: ({ className, ...props }) => <ul className={cn("my-1.5 list-disc space-y-0.5 pl-5 first:mt-0 last:mb-0", className)} {...props} />,
  ol: ({ className, ...props }) => <ol className={cn("my-1.5 list-decimal space-y-0.5 pl-5 first:mt-0 last:mb-0", className)} {...props} />,
  li: ({ className, ...props }) => <li className={cn("pl-0.5", className)} {...props} />,
  blockquote: ({ className, ...props }) => (
    <blockquote className={cn("my-2 border-l-2 border-[color:var(--color-border-strong)] pl-3 text-[color:var(--color-fg-muted)]", className)} {...props} />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn("font-medium text-[color:var(--color-brand)] underline decoration-[color:var(--color-brand)]/40 underline-offset-2 hover:decoration-[color:var(--color-brand)]", className)}
      target="_blank"
      rel="noreferrer noopener"
      {...props}
    />
  ),
  inlineCode: ({ className, ...props }) => (
    <code className={cn("rounded bg-[color:var(--color-surface-2)] px-1 py-0.5 font-mono text-[0.86em] text-[color:var(--color-fg)]", className)} {...props} />
  ),
  pre: ({ className, ...props }) => (
    <pre className={cn("my-2 max-w-full overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-3 font-mono text-xs leading-5 text-[color:var(--color-fg-muted)] first:mt-0 last:mb-0", className)} {...props} />
  ),
  table: ({ className, ...props }) => (
    <div className="my-2 max-w-full overflow-x-auto">
      <table className={cn("min-w-full border-collapse text-left text-xs", className)} {...props} />
    </div>
  ),
  thead: ({ className, ...props }) => <thead className={cn("border-b border-[color:var(--color-border)] text-[color:var(--color-fg)]", className)} {...props} />,
  tbody: ({ className, ...props }) => <tbody className={cn("divide-y divide-[color:var(--color-border)]/70", className)} {...props} />,
  th: ({ className, ...props }) => <th className={cn("whitespace-nowrap px-2 py-1.5 font-medium", className)} {...props} />,
  td: ({ className, ...props }) => <td className={cn("px-2 py-1.5 align-top text-[color:var(--color-fg-muted)]", className)} {...props} />,
  hr: ({ className, ...props }) => <hr className={cn("my-3 border-[color:var(--color-border)]", className)} {...props} />,
};
