import type { ComponentProps } from "react";
import { ProviderTile } from "./models-ui";
import { ListRow } from "@/components/ui/list-row";
import { MetaChip } from "@/components/ui/meta-chip";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";

/** The on/off words for an account's allocator, shared by its switch and read-only facts. */
export const ACCOUNT_ENABLED_LABELS = { on: "Enabled", off: "Disabled" } as const;

/** Whether new work may pick a subscription account. Running work is never interrupted. */
export function EnableAccountRow({
  name,
  checked,
  pending,
  disabled,
  onCheckedChange,
}: {
  name: string;
  checked: boolean;
  pending: boolean;
  disabled: boolean;
  onCheckedChange: (enabled: boolean) => void;
}) {
  return (
    <SettingRow
      label="Enable account"
      description="Allow this account to be used for new work. Turning it off won’t interrupt running work."
      control={
        <Switch
          aria-label={`Enable ${name}`}
          showStateText
          stateLabels={ACCOUNT_ENABLED_LABELS}
          checked={checked}
          pending={pending}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
      }
    />
  );
}

export function SubscriptionAccountRow({
  provider,
  primary = false,
  email,
  ...row
}: Omit<ComponentProps<typeof ListRow>, "leading" | "titleAddon"> & {
  provider: "codex" | "supergrok" | "claude_subscription";
  primary?: boolean;
  email?: string | null;
}) {
  const identity = email && email.toLowerCase() !== String(row.title).toLowerCase() ? email : null;
  return (
    <ListRow
      {...row}
      leading={<ProviderTile provider={provider} size="lg" />}
      titleAddon={primary ? <MetaChip variant="outline">Primary</MetaChip> : null}
      meta={identity ? [...(row.meta ?? []), identity] : row.meta}
    />
  );
}

/** One account-distribution control for providers using the shared allocator. */
export function SubscriptionRotationSettingRows({
  rotationEnabled,
  pending,
  disabled,
  onChange,
  label = "When several accounts are connected",
}: {
  rotationEnabled: boolean;
  pending: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
  label?: string;
}) {
  return (
    <SettingRowGroup>
      <SettingRow
        label={label}
        description="Spread work shares new chats evenly across accounts that can serve them. Primary first starts new chats on the primary account and uses another account when it can't serve them."
        controlWidth="auto"
        control={
          <SegmentedControl<"spread" | "primary">
            size="sm"
            pending={pending}
            disabled={disabled}
            value={rotationEnabled ? "spread" : "primary"}
            onValueChange={(value) => onChange(value === "spread")}
            options={[
              { value: "spread", label: "Spread work" },
              { value: "primary", label: "Primary first" },
            ]}
          />
        }
      />
    </SettingRowGroup>
  );
}
