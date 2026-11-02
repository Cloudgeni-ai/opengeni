/**
 * How an agent's intro looks in Slack: its icon, name and APP badge over the
 * exact lines the API posts, built by the same contracts function.
 */
import {
  slackAgentIntroLines,
  slackAgentMessagePlainText,
  type SlackAgentMessageSegment,
} from "@opengeni/contracts";
import type { SessionAvatar as SessionAvatarValue } from "@opengeni/sdk";

import { SessionAvatar } from "@opengeni/react/app/components/session/session-avatar";

function Mention({ children }: { children: string }) {
  return (
    <span className="rounded-[3px] bg-[#1d9bd1]/10 px-0.5 text-[#1264a3] dark:bg-[#1d9bd1]/20 dark:text-[#4fb5e8]">
      {children}
    </span>
  );
}

function segmentKey(segment: SlackAgentMessageSegment): string {
  switch (segment.kind) {
    case "text":
    case "bold":
      return `${segment.kind}:${segment.text}`;
    case "opengeni":
      return "opengeni";
    case "person":
      return `person:${segment.name}`;
  }
}

function Segment({ segment }: { segment: SlackAgentMessageSegment }) {
  switch (segment.kind) {
    case "text":
      return <>{segment.text}</>;
    case "bold":
      return <strong className="font-semibold">{segment.text}</strong>;
    case "opengeni":
      return <Mention>@Opengeni</Mention>;
    case "person":
      return <Mention>{`@${segment.name}`}</Mention>;
  }
}

/** A person's short name for the preview's "Added by" line. */
export function previewPersonName(label: string | null | undefined): string {
  const trimmed = label?.trim() ?? "";
  if (!trimmed) return "you";
  return trimmed.includes("@") ? trimmed.slice(0, trimmed.indexOf("@")) : trimmed;
}

export function SlackAgentIntroPreview({
  name,
  description,
  avatar,
  workspaceId,
  seed,
  addedBy,
}: {
  name: string;
  description: string;
  /** Null while the icon is incomplete; the preview keeps a blank square. */
  avatar: SessionAvatarValue | null;
  workspaceId: string;
  seed: string;
  /** The viewer, who would post it. */
  addedBy: string;
}) {
  const shownName = name.trim() || "Your agent";
  const lines = slackAgentIntroLines({
    name: shownName,
    description: description.trim() || "What it helps with.",
    addedBy: { slackUserId: null, name: addedBy },
  });
  return (
    <figure className="grid gap-1.5" data-slack-agent-intro-preview="">
      <figcaption className="text-xs font-medium text-fg-muted">Preview in Slack</figcaption>
      <div className="flex gap-2.5 rounded-md border border-border bg-bg px-3 py-2.5 text-[15px] leading-[1.46668]">
        <div className="pt-0.5">
          {avatar ? (
            <SessionAvatar
              avatar={avatar}
              name={shownName}
              workspaceId={workspaceId}
              seed={seed}
              size="md"
              className="size-9 rounded-md"
            />
          ) : (
            <span className="block size-9 rounded-md bg-fg/10" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-fg">{shownName}</span>
            <span className="rounded-[3px] bg-fg/10 px-1 text-[10px] font-semibold leading-4 text-fg-muted">
              APP
            </span>
          </div>
          {lines.map((line) => (
            <p
              key={slackAgentMessagePlainText([line])}
              className={line.italic ? "break-words text-fg italic" : "break-words text-fg"}
            >
              {line.segments.map((segment) => (
                <Segment key={segmentKey(segment)} segment={segment} />
              ))}
            </p>
          ))}
        </div>
      </div>
    </figure>
  );
}
