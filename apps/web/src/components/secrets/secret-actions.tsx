import type { VaultsApi } from "@opengeni/react";
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, LinkIcon } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { copyText } from "@/components/ui/copy-field";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { vaultErrorText } from "./vault-model";

/* ----------------------------------------------------------------------------
   The small icon actions on a secret value: Reveal, Copy, Copy reference.
   32px to look quiet in a row; an ::after extends the hit area to 40px.
   -------------------------------------------------------------------------- */

/**
 * For a page root: every button and link under it gets an invisible hit area
 * of at least 40x40px centred on it (UI-7), without changing how it looks.
 * Absolutely positioned controls (a search field's clear button) keep theirs.
 */
export const MIN_HIT_AREAS = [
  "[&_:is(button,a[href]):not(.absolute,.fixed,.sticky)]:relative",
  "[&_:is(button,a[href])]:after:absolute [&_:is(button,a[href])]:after:top-1/2 [&_:is(button,a[href])]:after:left-1/2",
  "[&_:is(button,a[href])]:after:h-[max(100%,40px)] [&_:is(button,a[href])]:after:w-[max(100%,40px)]",
  "[&_:is(button,a[href])]:after:-translate-1/2 [&_:is(button,a[href])]:after:content-['']",
].join(" ");

export const HIT_AREA =
  "relative after:absolute after:-inset-1 after:content-[''] pointer-coarse:size-11";

export function IconAction({
  label,
  tooltip,
  pressed,
  disabled,
  onClick,
  children,
  className,
}: {
  label: string;
  /** Defaults to the label. */
  tooltip?: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={pressed}
          disabled={disabled}
          onClick={onClick}
          className={cn("text-fg-muted hover:text-fg", HIT_AREA, className)}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 break-all">{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
}

export function RevealAction({
  name,
  revealed,
  pending,
  disabled,
  onToggle,
}: {
  name: string;
  revealed: boolean;
  pending?: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <IconAction
      label={`Reveal ${name}`}
      tooltip={revealed ? "Hide" : "Reveal"}
      pressed={revealed}
      disabled={disabled || pending}
      onClick={onToggle}
    >
      {revealed ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
    </IconAction>
  );
}

/** Copies a value; toasts "Copied" for 2 seconds. `value` may be async (a reveal). */
export function CopyAction({
  name,
  value,
  disabled,
}: {
  name: string;
  value: string | (() => Promise<string>);
  disabled?: boolean;
}) {
  return (
    <IconAction
      label={`Copy ${name}`}
      tooltip="Copy"
      disabled={disabled}
      onClick={() => void copyWithToast(value, name)}
    >
      <CopyIcon aria-hidden="true" />
    </IconAction>
  );
}

export function CopyReferenceAction({ name, reference }: { name: string; reference: string }) {
  return (
    <IconAction
      label={`Copy reference for ${name}`}
      tooltip={
        <span className="font-mono text-xs">
          Copy reference
          <br />
          {reference}
        </span>
      }
      onClick={() => void copyWithToast(reference, `${name} reference`, "Reference copied")}
    >
      <LinkIcon aria-hidden="true" />
    </IconAction>
  );
}

export async function copyWithToast(
  value: string | (() => Promise<string>),
  name: string,
  message = "Copied",
): Promise<boolean> {
  let text: string;
  try {
    text = typeof value === "string" ? value : await value();
  } catch (error) {
    toast.error(vaultErrorText(error, `Couldn't copy ${name}.`));
    return false;
  }
  const ok = await copyText(text);
  if (ok) toast.success(message, { duration: 2000, icon: <CheckIcon className="size-4" /> });
  else toast.error(`Couldn't copy ${name}. Your browser blocked the clipboard.`);
  return ok;
}

/** A field's reveal call, decoded to text. */
export async function revealText(
  api: VaultsApi,
  vaultId: string,
  itemId: string,
  fieldId: string,
  version?: number,
): Promise<string> {
  const result = await api.revealField(vaultId, itemId, fieldId, version);
  if (result.encoding === "base64") return atob(result.value);
  return result.value;
}
