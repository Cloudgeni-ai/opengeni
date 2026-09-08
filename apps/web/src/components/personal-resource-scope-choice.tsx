import { useId } from "react";
import { InfoIcon, ShieldCheckIcon } from "lucide-react";
import { Select } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { PersonalAttachmentMode } from "@/lib/personal-resource-attachments";

export function PersonalResourceScopeChoice(props: {
  mode: PersonalAttachmentMode;
  onModeChange: (mode: PersonalAttachmentMode) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Collapsible className="min-w-0 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <label htmlFor={id} className="flex items-center gap-1.5 text-fg-muted">
          <ShieldCheckIcon className="size-3.5" aria-hidden />
          Personal access
        </label>
        <Select
          id={id}
          value={props.mode}
          disabled={props.disabled}
          aria-describedby={`${id}-timing`}
          onChange={(event) => props.onModeChange(event.target.value as PersonalAttachmentMode)}
          className="h-8 rounded-full bg-bg-subtle text-xs pointer-coarse:h-11"
        >
          <option value="once">This message only</option>
          <option value="session">Ongoing work in this chat</option>
        </Select>
        <CollapsibleTrigger
          aria-label="About personal access"
          className="flex size-8 items-center justify-center rounded-full text-fg-subtle hover:bg-bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
        >
          <InfoIcon className="size-3.5" aria-hidden />
        </CollapsibleTrigger>
        <span id={`${id}-timing`} className="text-2xs text-fg-subtle">
          Applies when you send
        </span>
      </div>
      <CollapsibleContent className="pt-2 text-2xs leading-4 text-fg-subtle">
        <p>
          Your next message or Continue authorizes the selected personal resources.
          {props.mode === "once"
            ? " Later automatic work may need another authorization."
            : " Ongoing access includes follow-up work initiated on your behalf in this chat."}{" "}
          Other members may see results, but cannot use your credentials.
        </p>
        <p className="mt-1">
          This choice is for your next send, not an access switch. Changing it does not revoke
          existing access.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
