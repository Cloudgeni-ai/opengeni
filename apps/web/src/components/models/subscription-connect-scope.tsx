import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";

/** Shared ownership choice for subscription accounts in an ordinary workspace. */
export function SubscriptionConnectScope({
  value,
  onChange,
  disabled,
  scopeName,
}: {
  value: "workspace" | "user";
  onChange(value: "workspace" | "user"): void;
  disabled: boolean;
  scopeName: string;
}) {
  return (
    <ChoiceCards
      label="Who can use it"
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next as "workspace" | "user")}
    >
      <ChoiceCard
        value="workspace"
        title="Everyone in this workspace"
        description={`New work in ${scopeName} can use it.`}
      />
      <ChoiceCard
        value="user"
        title="Only me"
        description="Only work you start uses it. Nobody else in the workspace can."
      />
    </ChoiceCards>
  );
}
