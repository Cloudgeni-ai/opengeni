import {
  ArrowLeftIcon,
  Maximize2Icon,
  RefreshCwIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import {
  PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX,
  PublishedHtmlArtifactFrame,
} from "@opengeni/react/artifacts";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export { PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX };

export function ArtifactSandbox(props: {
  html: string;
  title: string;
  versionLabel?: string;
  className?: string;
  editDisabled?: boolean;
  onEdit?: () => void;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [focused, setFocused] = useState(false);
  const [running, setRunning] = useState(true);
  const reload = () => {
    setRunning(true);
    setReloadKey((value) => value + 1);
  };
  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-white",
        focused && "fixed inset-0 z-50 flex flex-col border-0 bg-surface",
        props.className,
      )}
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          {focused ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2"
              onClick={() => setFocused(false)}
            >
              <ArrowLeftIcon className="mr-2 size-3.5" />
              Back
            </Button>
          ) : null}
          <span className="truncate text-xs font-medium text-fg">{props.title}</span>
          {props.versionLabel ? (
            <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-fg-subtle">
              {props.versionLabel}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {focused && props.onEdit ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              disabled={props.editDisabled}
              onClick={props.onEdit}
            >
              <SparklesIcon className="mr-2 size-3.5" />
              <span className="hidden sm:inline">Edit with Geni</span>
              <span className="sm:hidden">Edit</span>
            </Button>
          ) : null}
          {running ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Stop artifact"
              onClick={() => setRunning(false)}
            >
              <SquareIcon className="size-3" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Reload artifact"
            onClick={reload}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          {!focused ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Open focus mode"
              onClick={() => setFocused(true)}
            >
              <Maximize2Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
      {running ? (
        <PublishedHtmlArtifactFrame
          key={reloadKey}
          title={props.title}
          html={props.html}
          className={cn("h-[62vh] w-full border-0 bg-white", focused && "min-h-0 flex-1")}
        />
      ) : (
        <div
          className={cn(
            "flex h-[62vh] w-full flex-col items-center justify-center gap-2 bg-surface-2/30 text-center",
            focused && "min-h-0 flex-1",
          )}
        >
          <p className="text-sm font-medium text-fg">Artifact stopped</p>
          <p className="text-xs text-fg-subtle">Reload to run it again.</p>
        </div>
      )}
    </section>
  );
}
