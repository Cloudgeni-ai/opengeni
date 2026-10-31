import type { IntegrationWorkspaceFilter } from "@opengeni/sdk";

import { ChoiceCard, ChoiceCards } from "@opengeni/react/ui/choice-cards";
import { CheckboxField, Field, TextInput } from "@opengeni/react/ui/field";

/**
 * Which workspaces an organization registration reaches. The filter picks
 * shared workspaces. Personal workspaces are a separate choice, offered only
 * where the registration supports them (`personalWorkspaces`); webhooks never
 * reach them. The filter is a convenience, not a security boundary: receivers
 * still map the workspace id to their own tenant.
 */
export function WorkspaceFilterField({
  value,
  error,
  onChange,
  personalWorkspaces,
}: {
  value: IntegrationWorkspaceFilter | null;
  error?: string | undefined;
  onChange: (value: IntegrationWorkspaceFilter | null) => void;
  personalWorkspaces?: { checked: boolean; onChange: (checked: boolean) => void };
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ChoiceCards
        variant="radio"
        label="Workspaces"
        description={personalWorkspaces ? undefined : "Personal workspaces are never included."}
        value={value ? "source" : "all"}
        onValueChange={(next) => onChange(next === "all" ? null : { externalSource: "" })}
      >
        <ChoiceCard value="all" title="Every shared workspace" />
        <ChoiceCard
          value="source"
          title="Workspaces your product created"
          description="Only workspaces with this external source, for example one product's environment."
        />
      </ChoiceCards>
      {value ? (
        <Field
          label="External source"
          error={error}
          hint="Exactly as your product passes it to ensureWorkspace."
        >
          <TextInput
            value={value.externalSource}
            placeholder="your-product:production"
            onChange={(event) => onChange({ externalSource: event.target.value })}
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
