import { useId } from "react";
import type { PersonalAttachmentMode } from "@/lib/personal-resource-attachments";

export function PersonalResourceScopeChoice(props: {
  mode: PersonalAttachmentMode;
  onModeChange: (mode: PersonalAttachmentMode) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <fieldset disabled={props.disabled} className="min-w-0 space-y-1.5 text-xs">
      <legend className="font-medium text-fg">Authorize my selected personal resources</legend>
      <label className="flex min-h-9 pointer-coarse:min-h-11 items-center gap-2">
        <input
          type="radio"
          name={id}
          checked={props.mode === "once"}
          onChange={() => props.onModeChange("once")}
        />
        This message only
      </label>
      <label className="flex min-h-9 pointer-coarse:min-h-11 items-center gap-2">
        <input
          type="radio"
          name={id}
          checked={props.mode === "session"}
          onChange={() => props.onModeChange("session")}
        />
        For my ongoing work in this session
      </label>
      <p className="text-2xs leading-4 text-fg-subtle">
        Applies to the authorization sent with your next message or Continue. Other members may see
        results, but cannot use your credentials.
        {props.mode === "once"
          ? " Later automatic work may need you to authorize another message."
          : " Includes follow-up work initiated on your behalf in this session."}
      </p>
      <p className="text-2xs leading-4 text-fg-subtle">
        Changing this choice does not revoke previously granted access.
      </p>
    </fieldset>
  );
}
