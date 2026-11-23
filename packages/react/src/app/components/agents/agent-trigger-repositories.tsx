/**
 * Which repositories a GitHub trigger covers: all the GitHub connection
 * reaches, or the ones chosen here. Each run checks out the repository its
 * event is about.
 */
import { GitBranchIcon, XIcon } from "lucide-react";
import type { GitHubRepository } from "@opengeni/sdk";

import { Field } from "../../../ui/field";
import { SelectMenu, type SelectOption } from "../../../ui/select-menu";
import {
  AGENT_TRIGGER_CHAT_REPOSITORIES_MAX,
  AGENT_TRIGGER_REPOSITORIES_MAX,
} from "./agent-trigger-model";

export function AgentTriggerRepositories({
  repositories,
  value,
  onChange,
  newChatPerRun,
}: {
  repositories: readonly Pick<GitHubRepository, "id" | "fullName">[];
  /** Chosen `owner/name`s; empty for all repositories. */
  value: readonly string[];
  onChange: (value: string[]) => void;
  /** A new chat per run opens its event's repository; a continued chat opens the chosen ones. */
  newChatPerRun: boolean;
}) {
  const options: SelectOption[] = repositories
    .filter((repo) => !value.includes(repo.fullName))
    .map((repo) => ({
      value: repo.fullName,
      label: repo.fullName,
      leading: <GitBranchIcon className="size-3.5 text-fg-subtle" />,
    }));
  const max = newChatPerRun ? AGENT_TRIGGER_REPOSITORIES_MAX : AGENT_TRIGGER_CHAT_REPOSITORIES_MAX;
  const full = value.length >= max;
  // Choosing a continued chat after more were chosen: the save waits for fewer.
  const over = value.length > max;
  return (
    <Field
      label="Repositories"
      error={over ? `A chat opens at most ${max}. Remove ${value.length - max}.` : undefined}
      hint={
        full
          ? `Up to ${max}.${newChatPerRun ? " Remove them all to cover every repository." : ""}`
          : newChatPerRun
            ? "Each run opens the one its event is about."
            : value.length === 0
              ? "Fires for every repository. Choose some for the chat to open them."
              : "Fires for these, and the chat opens them."
      }
    >
      <div data-agent-trigger-repositories="" className="flex min-w-0 flex-col gap-2">
        {value.length > 0 ? (
          <ul aria-label="Chosen repositories" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {value.map((name) => (
              <li
                key={name}
                className="inline-flex h-6 max-w-full min-w-0 items-center gap-1 rounded-full border border-border bg-surface-2 pr-0.5 pl-2 text-xs font-medium text-fg"
              >
                <span className="min-w-0 truncate">{name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${name}`}
                  onClick={() => onChange(value.filter((each) => each !== name))}
                  className="grid size-5 shrink-0 place-items-center rounded-full opacity-70 transition-opacity hover:opacity-100 pointer-coarse:size-8"
                >
                  <XIcon aria-hidden="true" className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <SelectMenu
          variant={options.length > 8 ? "combobox" : "menu"}
          options={options}
          value={null}
          placeholder={value.length === 0 ? "All repositories" : "Add a repository"}
          onValueChange={(name) => onChange([...value, name])}
          disabled={full || options.length === 0}
          searchPlaceholder="Search repositories"
          className="max-w-full"
        />
      </div>
    </Field>
  );
}
