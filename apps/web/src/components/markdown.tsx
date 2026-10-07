import { Markdown, type MarkdownProps } from "@opengeni/react";
import { consoleLinkResolver } from "@/lib/session-artifact-navigation";
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
  suppressImages = false,
  searchTarget,
  artifactHref,
  softLineBreaks = false,
}: {
  text: string;
  /** Chat message bodies: render single newlines as line breaks. */
  softLineBreaks?: boolean;
  artifactHref?: MarkdownProps["artifactHref"];
  searchTarget?: MarkdownProps["searchTarget"];
  renderImage?: MarkdownProps["renderImage"];
  suppressImages?: boolean;
  renderInteractiveBlock?: MarkdownProps["renderInteractiveBlock"];
  compact?: boolean;
  streaming?: boolean;
  onSandboxFile?: ((path: string, line?: number) => void | Promise<void>) | undefined;
}) {
  return (
    <Markdown
      artifactHref={artifactHref}
      resolveLink={consoleLinkResolver}
      searchTarget={searchTarget}
      softLineBreaks={softLineBreaks}
      streaming={streaming}
      renderImage={renderImage}
      suppressImages={suppressImages}
      renderInteractiveBlock={renderInteractiveBlock}
      onSandboxFile={onSandboxFile}
      className={cn("markdown-stream", compact && "markdown-stream-compact")}
    >
      {text}
    </Markdown>
  );
}
