import { SlidersHorizontalIcon } from "lucide-react";

/**
 * Shown next to the composer's "+" while this chat has its own capabilities,
 * so the choice is visible before sending. Opens + > Capabilities.
 */
export function ComposerCapabilitiesChip(props: {
  summary: string;
  disabled?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onOpen}
      aria-label={`Capabilities for this chat: ${props.summary}. Change`}
      title={`Capabilities for this chat: ${props.summary}`}
      className="inline-flex h-8 min-w-0 shrink items-center gap-1.5 rounded-full border border-brand/30 bg-brand/5 px-2.5 text-xs font-medium text-fg transition-colors duration-[120ms] hover:bg-brand/10 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 pointer-coarse:h-11"
    >
      <SlidersHorizontalIcon aria-hidden="true" className="size-3.5 shrink-0 text-brand" />
      <span className="truncate">{props.summary.replace(" capabilities", "")}</span>
    </button>
  );
}
