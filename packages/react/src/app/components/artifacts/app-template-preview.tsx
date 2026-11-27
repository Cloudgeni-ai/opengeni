import type { AppTemplate } from "@opengeni/sdk";
import { useMemo } from "react";

import { PublishedHtmlArtifactFrame } from "../../../components/artifacts/published-html-artifact-frame";
import { templatePreviewBridge } from "../../lib/app-template-preview";

/**
 * A ready-made app as it looks before it is installed: its own page, run in
 * the usual sandboxed frame on the template's sample records (read-only, in
 * memory). Drawn larger and scaled down, like a screenshot, without
 * scrollbars, and inert: it can't be clicked or focused.
 */
export function AppTemplatePreview({
  template,
  html,
}: {
  template: Pick<AppTemplate, "name" | "preview">;
  html: string;
}) {
  const toolBridge = useMemo(
    () => templatePreviewBridge(template.preview?.records ?? {}),
    [template],
  );
  return (
    <div
      className="relative h-52 overflow-hidden rounded-lg border border-border bg-white sm:h-60 dark:brightness-[0.88]"
      data-app-template-preview=""
      role="img"
      aria-label={`Preview of ${template.name}`}
      inert
    >
      <PublishedHtmlArtifactFrame
        html={stillHtml(html)}
        title={`Preview of ${template.name}`}
        toolBridge={toolBridge}
        theme="light"
        className="pointer-events-none absolute top-0 left-0 h-[166.667%] w-[166.667%] origin-top-left scale-[0.6] border-0 bg-white"
      />
    </div>
  );
}

const NO_SCROLLBARS = "<style>html{scrollbar-width:none}::-webkit-scrollbar{display:none}</style>";

/** The page without scrollbars, which read as part of the dialog in a still. */
function stillHtml(html: string): string {
  const head = /<\/head\s*>/i.exec(html);
  return head
    ? `${html.slice(0, head.index)}${NO_SCROLLBARS}${html.slice(head.index)}`
    : `${NO_SCROLLBARS}${html}`;
}
