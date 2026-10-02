import { MonitorIcon, MoonIcon, SunIcon, SunMoonIcon } from "lucide-react";

import {
  DropdownMenuCheck,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuMeta,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
      <DropdownMenuLabel>Appearance</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        aria-label="Appearance"
        value={appearance}
        onValueChange={(value) => setAppearance(parseAppearance(value))}
        className="grid grid-cols-3 gap-1 pb-1"
      >
        {options.map(({ value, label, icon: Icon }) => (
          <DropdownMenuRadioItem
            key={value}
            value={value}
            onSelect={(event) => event.preventDefault()}
            className="min-h-16 cursor-pointer flex-col justify-center gap-1.5 border border-transparent px-2 py-2 text-xs text-fg-muted data-[state=checked]:border-border-strong data-[state=checked]:bg-surface-2 data-[state=checked]:text-fg [&_[data-slot=dropdown-menu-item-indicator]]:hidden"
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

/**
 * The account menu's Appearance row: it shows the current choice and opens a
 * Light / Dark / System list with the chosen option checked on the right.
 */
export function AppearanceSubmenu() {
  const { appearance, setAppearance } = useAppearance();
  const current = options.find((option) => option.value === appearance);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <SunMoonIcon />
        Appearance
        <DropdownMenuMeta>{current?.label}</DropdownMenuMeta>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-40">
        {options.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem key={value} onSelect={() => setAppearance(value)}>
            <Icon />
            {label}
            <DropdownMenuCheck checked={appearance === value} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
