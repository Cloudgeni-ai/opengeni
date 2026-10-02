import { useState } from "react";

import { CodeBlock } from "@/components/ui/code-block";
import {
  LineTabs,
  LineTabsContent,
  LineTabsList,
  LineTabsTrigger,
} from "@/components/ui/line-tabs";
import { analyticsAction } from "@/lib/analytics-actions";
import type { CodingAgentGuide, CodingAgentId } from "@/lib/coding-agent-setup";

/**
 * One tab per coding agent (Claude Code, Codex, Cursor, VS Code, Other) with
 * what to run or paste: the Opengeni Developer plugin when building a
 * product, or the workspace MCP server when handing work to Opengeni.
 */
export function CodingAgentTabs({
  guides,
  onCopied,
}: {
  guides: readonly CodingAgentGuide[];
  /** A command or config was copied. */
  onCopied?: () => void;
}) {
  const [agent, setAgent] = useState<CodingAgentId>(guides[0]?.agent ?? "claude");
  return (
    <div className="flex min-w-0 flex-col gap-3" data-coding-agent-tabs="">
      <LineTabs value={agent} onValueChange={(value) => setAgent(value as CodingAgentId)}>
        <LineTabsList aria-label="Coding agent">
          {guides.map((guide) => (
            <LineTabsTrigger key={guide.agent} value={guide.agent}>
              {guide.label}
            </LineTabsTrigger>
          ))}
        </LineTabsList>
        {guides.map((guide) => (
          <LineTabsContent
            key={guide.agent}
            value={guide.agent}
            className="flex min-w-0 flex-col gap-3 pt-4"
          >
            {guide.blocks.map((block) => (
              <CodeBlock
                key={block.label}
                label={block.label}
                code={block.code}
                wrap
                {...(onCopied ? { onCopied } : {})}
                copyAnalytics={analyticsAction("copy_coding_agent_setup")}
              />
            ))}
            {guide.note ? <p className="text-xs leading-4.5 text-fg-muted">{guide.note}</p> : null}
          </LineTabsContent>
        ))}
      </LineTabs>
    </div>
  );
}
