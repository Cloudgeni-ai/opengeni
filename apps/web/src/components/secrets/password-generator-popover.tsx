import {
  generatePassword,
  passwordStrength,
  type GeneratePasswordSpecInput,
} from "@opengeni/contracts";
import { RefreshCwIcon, WandSparklesIcon } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useCallback, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { MENU_SURFACE_CLASS } from "@/components/ui/menu-styles";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   Generate: a popover next to a password field. Options (length, symbols)
   live here, out of the form; "Use password" fills the field.
   -------------------------------------------------------------------------- */

export const GENERATOR_MIN = 12;
export const GENERATOR_MAX = 64;
export const GENERATOR_DEFAULT = 24;

const STRENGTH_LABEL = {
  weak: "Weak",
  fair: "Fair",
  strong: "Strong",
  very_strong: "Very strong",
} as const;

export function PasswordGeneratorPopover({
  onUse,
  disabled,
}: {
  /** Called with the generated password; the caller fills its field. */
  onUse: (password: string, spec: GeneratePasswordSpecInput) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [length, setLength] = useState(GENERATOR_DEFAULT);
  const [symbols, setSymbols] = useState(true);
  const spec = useCallback(
    (next: { length?: number; symbols?: boolean } = {}): GeneratePasswordSpecInput => ({
      length: next.length ?? length,
      lowercase: true,
      uppercase: true,
      digits: true,
      symbols: next.symbols ?? symbols,
      excludeAmbiguous: true,
      requireEachClass: true,
    }),
    [length, symbols],
  );
  const make = (next: { length?: number; symbols?: boolean } = {}) => generatePassword(spec(next));
  const [preview, setPreview] = useState("");
  const lengthId = useId();
  const symbolsId = useId();
  const strength = preview ? passwordStrength(preview) : null;

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setPreview(make());
        else setPreview("");
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className="shrink-0 pointer-coarse:h-11"
        >
          <WandSparklesIcon aria-hidden="true" />
          Generate
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          aria-label="Generate a password"
          className={cn(MENU_SURFACE_CLASS, "z-50 w-80 max-w-[calc(100vw-1.5rem)] p-3")}
        >
          <div className="flex min-w-0 items-center gap-1 rounded-[10px] bg-surface-2 py-1 pr-1 pl-3">
            <output
              aria-label="Generated password"
              className="min-w-0 flex-1 font-mono text-sm leading-5 break-all text-fg"
            >
              {preview}
            </output>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Generate another"
              onClick={() => setPreview(make())}
              className="shrink-0 text-fg-muted hover:text-fg relative after:absolute after:-inset-1 after:content-[''] pointer-coarse:size-11"
            >
              <RefreshCwIcon aria-hidden="true" />
            </Button>
          </div>
          {strength ? (
            <p className="mt-1.5 mb-0 px-1 text-xs leading-4.5 text-fg-muted">
              {STRENGTH_LABEL[strength.label]} · {Math.round(strength.bits)} bits
            </p>
          ) : null}
          <div className="mt-3 flex flex-col gap-3 px-1">
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex items-center justify-between text-sm leading-5">
                <label htmlFor={lengthId} className="text-fg">
                  Length
                </label>
                <span className="text-fg-muted tabular-nums">{length}</span>
              </div>
              <input
                id={lengthId}
                type="range"
                min={GENERATOR_MIN}
                max={GENERATOR_MAX}
                value={length}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setLength(next);
                  setPreview(make({ length: next }));
                }}
                className="h-10 w-full accent-[var(--color-brand)]"
              />
            </div>
            <div className="flex min-h-10 items-center justify-between gap-3">
              <label htmlFor={symbolsId} className="text-sm leading-5 text-fg">
                Symbols
              </label>
              <Switch
                id={symbolsId}
                checked={symbols}
                onCheckedChange={(next) => {
                  setSymbols(next);
                  setPreview(make({ symbols: next }));
                }}
              />
            </div>
          </div>
          <Button
            type="button"
            className="mt-3 w-full pointer-coarse:h-11"
            onClick={() => {
              onUse(preview || make(), spec());
              setOpen(false);
            }}
          >
            Use password
          </Button>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
