/**
 * Which repositories a GitHub trigger covers: all the GitHub connection
 * reaches, or the ones chosen here. Each run checks out the repository its
 * event is about.
 */
import { GitBranchIcon, XIcon } from "lucide-react";
import type { GitHubRepository } from "@opengeni/sdk";

import { Field } from "../../../ui/field";
import { SelectMenu, type SelectOption } from "../../../ui/select-menu";
import { AGENT_TRIGGER_REPOSITORIES_MAX } from "./agent-trigger-model";

export function AgentTriggerRepositories({
  repositories,
  value,
  onChange,
}: {
  repositories: readonly Pick<GitHubRepository, "id" | "fullName">[];
  /** Chosen `owner/name`s; empty for all repositories. */
  value: readonly string[];
  onChange: (value: string[]) => void;
}) {
  const options: SelectOption[] = repositories
    .filter((repo) => !value.includes(repo.fullName))
    .map((repo) => ({
      value: repo.fullName,
      label: repo.fullName,
      leading: <GitBranchIcon className="size-3.5 text-fg-subtle" />,
    }));
  const full = value.length >= AGENT_TRIGGER_REPOSITORIES_MAX;
  return (
    <Field
      label="Repositories"
      hint={
        value.length === 0
          ? "Every repository. Each run opens the one its event is about."
          : "Each run opens the one its event is about."
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
