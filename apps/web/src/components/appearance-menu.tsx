import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { parseAppearance, useAppearance } from "@/lib/appearance";

const options = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
] as const;

export function AppearanceMenu() {
  const { appearance, setAppearance } = useAppearance();

  return (
    <>
      <DropdownMenuLabel className="text-xs font-normal text-fg-muted">
        Appearance
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        aria-label="Appearance"
        value={appearance}
        onValueChange={(value) => setAppearance(parseAppearance(value))}
        className="grid grid-cols-3 gap-1 px-1 pb-1"
      >
        {options.map(({ value, label, icon: Icon }) => (
          <DropdownMenuRadioItem
            key={value}
            value={value}
            onSelect={(event) => event.preventDefault()}
            className="min-h-16 cursor-pointer flex-col justify-center gap-1.5 rounded-md border border-transparent px-2 py-2 text-xs text-fg-muted data-[state=checked]:border-border-strong data-[state=checked]:bg-surface-2 data-[state=checked]:text-fg [&>span]:top-1.5 [&>span]:right-1.5 [&>span]:left-auto [&>span]:size-2"
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
    </>
  );
}
