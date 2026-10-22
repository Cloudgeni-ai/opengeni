import { Markdown, type MarkdownProps } from "../../components/markdown";
import { consoleLinkResolver } from "../lib/session-artifact-navigation";
import { cn } from "../lib/utils";

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
  softLineBreaks?: boolean | undefined;
  artifactHref?: MarkdownProps["artifactHref"] | undefined;
  searchTarget?: MarkdownProps["searchTarget"] | undefined;
  renderImage?: MarkdownProps["renderImage"] | undefined;
  suppressImages?: boolean | undefined;
  renderInteractiveBlock?: MarkdownProps["renderInteractiveBlock"] | undefined;
  compact?: boolean | undefined;
  streaming?: boolean | undefined;
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
