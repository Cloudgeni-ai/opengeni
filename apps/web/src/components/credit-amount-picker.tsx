import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";

export function CreditAmountPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [custom, setCustom] = useState(false);
  return (
    <div className="grid gap-2">
      <Label htmlFor="credit-preset">Amount in USD</Label>
      <Select
        id="credit-preset"
        value={custom ? "custom" : value}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          setCustom(next === "custom");
          onChange(next === "custom" ? "" : next);
        }}
      >
        <option value="10.00">$10 in credits</option>
        <option value="25.00">$25 in credits</option>
        <option value="50.00">$50 in credits</option>
        <option value="100.00">$100 in credits</option>
        <option value="custom">Custom amount…</option>
      </Select>
      {custom ? (
        <Input
          aria-label="Custom credit amount in USD"
          type="number"
          min="5"
          max="10000"
          step="0.01"
          placeholder="Enter amount ($5–$10,000)"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </div>
  );
}
