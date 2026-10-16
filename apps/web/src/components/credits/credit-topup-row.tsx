import { RowButton } from "@/components/ui/page-actions";
import { TextInput } from "@/components/ui/field";
import { SettingRow } from "@/components/ui/setting-row";
import { analyticsAction } from "@/lib/analytics-actions";
import { validTopupAmount } from "@/lib/format";

export function CreditTopupRow({
  amount,
  onAmountChange,
  onCheckout,
  busy,
  hasPlan,
}: {
  amount: string;
  onAmountChange: (amount: string) => void;
  onCheckout: (amount: number) => void;
  busy: boolean;
  hasPlan: boolean;
}) {
  return (
    <SettingRow
      label="Add credits"
      description={
        hasPlan
          ? "Extra credit, never expires. Minimum $5."
          : "For models and platform usage. Minimum $5."
      }
      controlWidth="auto"
      control={
        <div className="flex items-center gap-2">
          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-fg-subtle"
            >
              $
            </span>
            <TextInput
              aria-label="Amount to add (USD)"
              type="number"
              name="credit-amount"
              autoComplete="off"
              inputMode="decimal"
              min="5"
              max="10000"
              step="0.01"
              value={amount}
              onChange={(event) => onAmountChange(event.target.value)}
              className="h-8 w-28 pl-6 tabular-nums pointer-coarse:h-11"
            />
          </div>
          <RowButton
            variant="default"
            {...analyticsAction("buy_credits")}
            disabled={busy || !validTopupAmount(amount)}
            onClick={() => onCheckout(Number(amount))}
          >
            Add credits
          </RowButton>
        </div>
      }
    />
  );
}
