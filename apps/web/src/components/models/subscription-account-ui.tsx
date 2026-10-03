import type { ComponentProps } from "react";
import { ProviderTile } from "./models-ui";
import { ListRow } from "@/components/ui/list-row";
import { MetaChip } from "@/components/ui/meta-chip";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";

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
        description="Spread work distributes new chats across available accounts. Primary only uses the primary account."
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
              { value: "primary", label: "Primary only" },
            ]}
          />
        }
      />
    </SettingRowGroup>
  );
}
