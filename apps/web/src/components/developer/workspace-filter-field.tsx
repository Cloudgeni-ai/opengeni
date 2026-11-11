import type { IntegrationWorkspaceFilter } from "@opengeni/sdk";
import { useCallback, useEffect, useState } from "react";

import { WorkspaceChecklist } from "@opengeni/react/app/components/workspace-reach";
import { ChoiceCard, ChoiceCards } from "@opengeni/react/ui/choice-cards";
import { CheckboxField, Field, TextInput } from "@opengeni/react/ui/field";

/** Where an organization registration works: its filter and its picked workspaces. */
export type RegistrationReach = {
  filter: IntegrationWorkspaceFilter | null;
  /** The shared workspaces it covers; null for every one, new ones too. */
  workspaceIds: string[] | null;
};

/**
 * Which workspaces an organization registration reaches: every shared
 * workspace, the ones picked here, or the ones a product created (its
 * external source). Personal workspaces are a separate choice, offered only
 * where the registration supports them (`personalWorkspaces`); webhooks never
 * reach them. The filter is a convenience, not a security boundary: receivers
 * still map the workspace id to their own tenant.
 */
export function WorkspaceFilterField({
  value,
  error,
  onChange,
  listWorkspaces,
  personalWorkspaces,
}: {
  value: RegistrationReach;
  error?: string | undefined;
  onChange: (value: RegistrationReach) => void;
  /** The organization's shared workspaces; "Selected workspaces" needs it. */
  listWorkspaces?: (() => Promise<{ id: string; name: string }[]>) | undefined;
  personalWorkspaces?: { checked: boolean; onChange: (checked: boolean) => void };
}) {
  const choice = value.workspaceIds !== null ? "selected" : value.filter ? "source" : "all";
  const workspaces = useSharedWorkspaces(choice === "selected" ? listWorkspaces : undefined);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ChoiceCards
        variant="radio"
        label="Workspaces"
        description={personalWorkspaces ? undefined : "Personal workspaces are never included."}
        value={choice}
        onValueChange={(next) =>
          onChange(
            next === "selected"
              ? { filter: null, workspaceIds: value.workspaceIds ?? [] }
              : next === "source"
                ? { filter: value.filter ?? { externalSource: "" }, workspaceIds: null }
                : { filter: null, workspaceIds: null },
          )
        }
      >
        <ChoiceCard
          value="all"
          title="Every shared workspace"
          description="Including ones added later."
        />
        {listWorkspaces ? (
          <ChoiceCard
            value="selected"
            title="Selected workspaces"
            description="Only the shared workspaces you tick."
          />
        ) : null}
        <ChoiceCard
          value="source"
          title="Workspaces your product created"
          description="Only workspaces with this external source, for example one product's environment."
        />
      </ChoiceCards>
      {choice === "selected" ? (
        <WorkspaceChecklist
          workspaces={workspaces.workspaces}
          workspacesError={workspaces.error}
          onRetryWorkspaces={workspaces.retry}
          selected={value.workspaceIds ?? []}
          onSelectedChange={(next) => onChange({ filter: null, workspaceIds: next })}
          error={error}
        />
      ) : null}
      {choice === "source" && value.filter ? (
        <Field
          label="External source"
          error={error}
          hint="Exactly as your product passes it to ensureWorkspace."
        >
          <TextInput
            value={value.filter.externalSource}
            placeholder="your-product:production"
            onChange={(event) =>
              onChange({ filter: { externalSource: event.target.value }, workspaceIds: null })
            }
            suppressAutofill
          />
        </Field>
      ) : null}
      {personalWorkspaces ? (
        <CheckboxField
          label="Personal workspaces"
          description="Each member's own private workspace."
          checked={personalWorkspaces.checked}
          onCheckedChange={personalWorkspaces.onChange}
        />
      ) : null}
    </div>
  );
}

/** Loads the shared workspaces once "Selected workspaces" is chosen. */
function useSharedWorkspaces(list: (() => Promise<{ id: string; name: string }[]>) | undefined): {
  workspaces: { id: string; name: string }[] | null;
  error: boolean;
  retry: () => void;
} {
  const [state, setState] = useState<{
    workspaces: { id: string; name: string }[] | null;
    error: boolean;
  }>({ workspaces: null, error: false });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    if (!list) return;
    let live = true;
    setState({ workspaces: null, error: false });
    list().then(
      (workspaces) => {
        if (live) setState({ workspaces, error: false });
      },
      () => {
        if (live) setState({ workspaces: null, error: true });
      },
    );
    return () => {
      live = false;
    };
    // `list` comes from the memoized organization API, so it is stable.
  }, [list, attempt]);
  return { ...state, retry };
}
