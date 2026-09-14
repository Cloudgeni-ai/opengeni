import { Clock3, PanelsTopLeft, Search } from "lucide-react";
import slackLogo from "../../../../data/catalog/logos/slack-com-5a15dccc0dc0.jpg?url";
import linearLogo from "../../../../data/catalog/logos/linear-app-4b4a9f349c60.png?url";
import { Button } from "@/components/ui/button";

// Plain editable prompts, not service identifiers or a connector resolver.
export const NEW_SESSION_STARTERS = [
  {
    id: "slack",
    title: "Work with OpenGeni from Slack",
    description: "Install the bot. Start tasks and follow up on the go.",
    prompt:
      "Help me install the OpenGeni Slack bot so I can ask questions, start work, and follow up from Slack, including on my phone.",
  },
  {
    id: "github",
    title: "Connect GitHub and start a fix",
    description: "Explore a repository and find an improvement to make.",
    prompt:
      "Help me connect a GitHub repository. Explain the codebase, suggest a useful improvement, and help me implement it once we agree on the change.",
  },
  {
    id: "linear",
    title: "Connect Linear and analyze issues",
    description: "Find blockers and decide what to tackle next.",
    prompt:
      "Help me connect Linear and analyze a project's open issues. Highlight blockers and possible duplicates, then recommend what to tackle next. Don't change any issues yet.",
  },
  {
    id: "schedule",
    title: "Schedule a morning brief",
    description: "Stay up to date without asking every day.",
    prompt:
      "Help me schedule a weekday morning brief. Ask what I want to track, which sources to use, my time zone, and where to deliver it. Show me a sample and let me confirm before enabling the schedule.",
  },
  {
    id: "research",
    title: "Research a decision",
    description: "Compare options and get a sourced recommendation.",
    prompt:
      "Help me research a decision. Ask what I am deciding and what matters most, compare the options, and recommend a next step with sources.",
  },
  {
    id: "create",
    title: "Turn an idea into a first version",
    description: "Make a presentation, prototype, or shareable page.",
    prompt:
      "Help me turn an idea into something real. Ask about the idea and its audience, suggest whether to make a presentation, prototype, or shareable page, then help me build a first version.",
  },
] as const;

export function NewSessionStarters({
  onSelect,
  disabled = false,
}: {
  onSelect: (prompt: string) => void;
  disabled?: boolean;
}) {
  return (
    <section className="mt-8" aria-label="Starter suggestions">
      <h2 className="mb-2 px-0.5 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
        Suggestions
      </h2>
      <div className="grid auto-rows-fr grid-cols-1 gap-2 sm:grid-cols-2">
        {NEW_SESSION_STARTERS.map((starter) => {
          const Icon =
            starter.id === "schedule" ? Clock3 : starter.id === "research" ? Search : PanelsTopLeft;
          const logo =
            starter.id === "slack" ? slackLogo : starter.id === "linear" ? linearLogo : null;
          return (
            <Button
              key={starter.id}
              type="button"
              variant="outline"
              disabled={disabled}
              className="h-full min-h-16 justify-start gap-3 whitespace-normal px-3 py-3 text-left"
              onClick={() => onSelect(starter.prompt)}
            >
              {logo ? (
                <img
                  src={logo}
                  alt=""
                  aria-hidden="true"
                  className="size-8 shrink-0 rounded-sm object-contain"
                />
              ) : starter.id === "github" ? (
                <GitHubMark />
              ) : (
                <Icon aria-hidden="true" className="size-5 text-fg-subtle" />
              )}
              <span className="min-w-0">
                <span className="block text-sm">{starter.title}</span>
                <span className="mt-1 block text-xs font-normal text-fg-muted">
                  {starter.description}
                </span>
              </span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}

// GitHub's vendor mark, inlined as a small SVG so it works offline and inherits
// the foreground color in both themes. No remote favicon or base64 module.
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="size-8 shrink-0">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}
