import {
  ArrowLeftIcon,
  Maximize2Icon,
  PlugZapIcon,
  RefreshCwIcon,
  SparklesIcon,
  SquareIcon,
} from "lucide-react";
import {
  PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX,
  PublishedHtmlArtifactFrame,
  publishedHtmlArtifactDocument,
  type PublishedHtmlArtifactToolBridge,
} from "@opengeni/react/artifacts";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export { PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX, publishedHtmlArtifactDocument };

export function ArtifactSandbox(props: {
  html: string;
  title: string;
  versionLabel?: string;
  className?: string;
  editDisabled?: boolean;
  onEdit?: () => void;
  toolBridge?: PublishedHtmlArtifactToolBridge;
  connectedToolCount?: number;
  sourceFileCount?: number;
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
        "overflow-hidden rounded-xl border border-border bg-white shadow-xs",
        focused && "fixed inset-0 z-50 flex flex-col rounded-none border-0 bg-surface",
        props.className,
      )}
    >
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-2.5 py-1.5 sm:px-3">
        <div className="flex min-w-0 items-center gap-2">
          {focused ? (
            <Button
              variant="ghost"
              size="sm"
              className="min-h-9 shrink-0 px-2"
              onClick={() => setFocused(false)}
            >
              <ArrowLeftIcon className="mr-2 size-3.5" />
              Back
            </Button>
          ) : null}
          <span className="truncate text-xs font-medium text-fg">{props.title}</span>
          {props.versionLabel ? (
            <Badge variant="outline" className="hidden text-2xs font-normal sm:inline-flex">
              {props.versionLabel}
            </Badge>
          ) : null}
          {props.connectedToolCount ? (
            <Badge
              variant="secondary"
              className="hidden max-w-40 gap-1 text-2xs font-normal sm:inline-flex"
              title={`${props.connectedToolCount} workspace tools available to this Site`}
            >
              <PlugZapIcon className="size-3" />
              {props.connectedToolCount} {props.connectedToolCount === 1 ? "tool" : "tools"}
            </Badge>
          ) : null}
          {props.sourceFileCount ? (
            <span className="hidden text-2xs text-fg-subtle lg:inline">
              {props.sourceFileCount} source {props.sourceFileCount === 1 ? "file" : "files"}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {focused && props.onEdit ? (
            <Button
              variant="ghost"
              size="sm"
              className="min-h-9 px-2"
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
              className="size-9"
              aria-label="Stop Site"
              onClick={() => setRunning(false)}
            >
              <SquareIcon className="size-3" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            aria-label="Reload Site"
            onClick={reload}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          {!focused ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              aria-label="Open Site full screen"
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
          toolBridge={props.toolBridge}
          className={cn(
            "h-[62vh] min-h-[28rem] w-full border-0 bg-white",
            focused && "min-h-0 flex-1",
          )}
        />
      ) : (
        <div
          className={cn(
            "flex h-[62vh] min-h-[28rem] w-full flex-col items-center justify-center gap-2 bg-surface-2/30 px-6 text-center",
            focused && "min-h-0 flex-1",
          )}
        >
          <p className="text-sm font-medium text-fg">Site preview stopped</p>
          <p className="text-xs text-fg-subtle">Reload when you’re ready to run it again.</p>
        </div>
      )}
    </section>
  );
}
