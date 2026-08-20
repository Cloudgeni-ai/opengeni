import { Markdown } from "@opengeni/react";
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
  onSandboxFile,
}: {
  text: string;
  compact?: boolean;
  streaming?: boolean;
  onSandboxFile?: ((path: string) => void | Promise<void>) | undefined;
}) {
  return (
    <Markdown
      streaming={streaming}
      onSandboxFile={onSandboxFile}
      className={cn("markdown-stream", compact && "markdown-stream-compact")}
    >
      {text}
    </Markdown>
  );
}
