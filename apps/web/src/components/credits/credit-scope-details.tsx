import { ChevronDownIcon, MicIcon } from "lucide-react";
import { modelDisplayName } from "@opengeni/sdk/model-display";
import { ModelMark } from "@opengeni/react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";

/** A balance row opens its current coverage without leaving billing. */
export function CreditScopeDetails({
  label,
  amount,
  eligibleModelIds,
  coversVoice = false,
}: {
  label: string;
  amount: string;
  eligibleModelIds: readonly string[];
  /** Also pays for dictation and live voice. */
  coversVoice?: boolean | undefined;
}) {
  return (
    <Collapsible className="group/credit min-w-0">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto min-h-16 w-full justify-between rounded-[10px] px-2 py-3 text-left"
          aria-label={`${label}, ${amount}. View covered models`}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-fg">{label}</span>
            <span className="mt-0.5 block text-xs font-normal text-fg-muted">
              Free credits · View models
            </span>
          </span>
          <span className="shrink-0 text-sm font-medium text-fg tabular-nums">{amount}</span>
          <ChevronDownIcon
            aria-hidden="true"
            className="size-4 text-fg-muted transition-transform group-data-[state=open]/credit:rotate-180 motion-reduce:transition-none"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2 pb-4">
        <ul className="grid gap-2 text-sm text-fg-muted">
          {eligibleModelIds.map((id) => (
            <li key={id} className="flex items-center gap-2">
              <ModelMark model={{ id, label: modelDisplayName(id) }} className="size-4" />
              {modelDisplayName(id)}
            </li>
          ))}
          {coversVoice ? (
            <li className="flex items-center gap-2">
              <MicIcon aria-hidden="true" className="size-4" />
              Dictation and live voice
            </li>
          ) : null}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
