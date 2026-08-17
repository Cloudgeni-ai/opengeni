import { Markdown, SettledMarkdown } from "@opengeni/react";
import { cn } from "@/lib/utils";

/**
 * App markdown surface. Uses the SDK {@link Markdown} renderer so streaming
 * word entrance, incomplete-marker softening, and crystallize settle stay on
 * the same path as embedders — Streamdown was bypassing all of that.
 */
export function MarkdownText({
  text,
  compact = false,
  streaming = false,
  settled = false,
}: {
  text: string;
  compact?: boolean;
  streaming?: boolean;
  settled?: boolean;
}) {
  const className = cn("markdown-stream", compact && "markdown-stream-compact");
  if (settled) {
    return <SettledMarkdown className={className}>{text}</SettledMarkdown>;
  }
  return (
    <Markdown streaming={streaming} className={className}>
      {text}
    </Markdown>
  );
}
