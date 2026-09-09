import { ShieldCheckIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "../../src/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../../src/components/ui/dropdown-menu";

// Proposed component only; deliberately not wired into the production route before approval.
export function ProposedAccess(props: {
  mode: "once" | "session";
  setMode: (mode: "once" | "session") => void;
  ongoing: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Personal access"
          className={`h-8 shrink-0 gap-1.5 rounded-full border px-2.5 text-xs ${props.ongoing ? "border-status-success/30 bg-status-success/10 text-status-success" : props.mode === "session" ? "border-brand/35 bg-brand/10 text-fg" : "border-transparent text-fg-muted"}`}
        >
          <ShieldCheckIcon className="size-3.5" />
          <span className="max-sm:hidden">Personal access · </span>
          <span>
            {props.ongoing
              ? "Ongoing"
              : props.mode === "session"
                ? "Ongoing on send"
                : "This message"}
          </span>
          <ChevronDownIcon className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        className="w-[min(20rem,calc(100vw-1.5rem))] rounded-xl p-2"
      >
        <DropdownMenuLabel>Personal access</DropdownMenuLabel>
        <p className="px-2 pb-3 text-xs text-fg-muted">
          My personal setup · Choose access for your next send
        </p>
        <DropdownMenuRadioGroup
          value={props.mode}
          onValueChange={(value) => props.setMode(value as "once" | "session")}
        >
          <DropdownMenuRadioItem value="once" className="min-h-11 py-3">
            This message only
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="session" className="min-h-11 py-3">
            Ongoing work in this chat
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {props.ongoing && (
          <p className="px-2 py-2 text-xs text-status-success">
            Ongoing access is active for your work in this chat.
          </p>
        )}
        <p className="px-2 py-2 text-xs leading-5 text-fg-muted">
          Applies when you send. Other members may see results, but cannot use your credentials.
          Changing this choice does not revoke existing access.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
