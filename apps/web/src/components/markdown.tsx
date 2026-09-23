import { Markdown, type MarkdownProps } from "@opengeni/react";
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
  renderInteractiveBlock,
  renderImage,
  searchTarget,
  artifactHref,
}: {
  text: string;
  artifactHref?: MarkdownProps["artifactHref"];
  searchTarget?: MarkdownProps["searchTarget"];
  renderImage?: MarkdownProps["renderImage"];
  renderInteractiveBlock?: MarkdownProps["renderInteractiveBlock"];
  compact?: boolean;
  streaming?: boolean;
  onSandboxFile?: ((path: string, line?: number) => void | Promise<void>) | undefined;
}) {
  return (
    <Markdown
      artifactHref={artifactHref}
      searchTarget={searchTarget}
      streaming={streaming}
      renderImage={renderImage}
      renderInteractiveBlock={renderInteractiveBlock}
      onSandboxFile={onSandboxFile}
      className={cn("markdown-stream", compact && "markdown-stream-compact")}
    >
      {text}
    </Markdown>
  );
}
