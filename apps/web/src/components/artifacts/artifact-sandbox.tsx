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
  type PublishedHtmlArtifactToolBridge,
} from "@opengeni/react/artifacts";
import type {
  ToolGatewayCallRequest,
  ToolGatewayCallResponse,
  ToolGatewayCatalogEntry,
} from "@opengeni/sdk";
import { sanitizeOpenGeniSiteToolCallRequest } from "@opengeni/sdk/site";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

export { PUBLISHED_HTML_ARTIFACT_IFRAME_SANDBOX };

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
  const pendingApprovalRef = useRef<PendingToolApproval | null>(null);
  const [pendingApprovalEntry, setPendingApprovalEntry] = useState<ToolGatewayCatalogEntry | null>(
    null,
  );
  const toolBridge = useApprovedToolBridge(
    props.toolBridge,
    pendingApprovalRef,
    setPendingApprovalEntry,
  );
  useEffect(() => () => rejectPendingApproval(pendingApprovalRef, "Site preview closed"), []);
  const reload = () => {
    rejectPendingApproval(pendingApprovalRef, "Site preview reloaded");
    setPendingApprovalEntry(null);
    setRunning(true);
    setReloadKey((value) => value + 1);
  };
  const closeApproval = () => {
    rejectPendingApproval(pendingApprovalRef, "Tool approval was declined");
    setPendingApprovalEntry(null);
  };
  const approveOnce = async () => {
    const pending = pendingApprovalRef.current;
    if (!pending) return;
    try {
      const approval = await pending.bridge.approve(pending.request, { signal: pending.signal });
      const response = await pending.bridge.call(
        { ...pending.request, approvalToken: approval.approvalToken },
        { signal: pending.signal },
      );
      pending.cleanup();
      pendingApprovalRef.current = null;
      setPendingApprovalEntry(null);
      pending.resolve(response);
    } catch (error) {
      pending.cleanup();
      pendingApprovalRef.current = null;
      setPendingApprovalEntry(null);
      pending.reject(error);
      toast.error("The Site tool couldn't run", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const pendingApprovalRequest = pendingApprovalEntry ? pendingApprovalRef.current?.request : null;
  const destructiveApproval = siteToolIsDestructive(pendingApprovalEntry);
  return (
    <>
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
                onClick={() => {
                  rejectPendingApproval(pendingApprovalRef, "Site preview stopped");
                  setPendingApprovalEntry(null);
                  setRunning(false);
                }}
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
            toolBridge={toolBridge}
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
      <ConfirmDialog
        open={pendingApprovalEntry !== null}
        onOpenChange={(open) => {
          if (!open) closeApproval();
        }}
        title={`Allow ${pendingApprovalEntry?.title ?? pendingApprovalEntry?.identity.toolName ?? "this tool"}?`}
        description={`“${props.title}” wants to run a workspace tool once with your current account. Review the exact target and arguments below; credentials stay outside the Site.${destructiveApproval ? " This tool reports that it may change or delete data." : ""}`}
        confirmLabel={destructiveApproval ? "Allow destructive action once" : "Allow once"}
        cancelAutoFocus
        destructive={destructiveApproval}
        onConfirm={approveOnce}
      >
        {pendingApprovalEntry && pendingApprovalRequest ? (
          <div className="grid gap-3 rounded-lg bg-surface-2 px-3 py-2.5 text-xs">
            <div>
              <p className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">
                Tool target
              </p>
              <p className="mt-1 font-medium text-fg">
                {pendingApprovalEntry.identity.serverId}.{pendingApprovalEntry.identity.toolName}
              </p>
            </div>
            {pendingApprovalEntry.description ? (
              <p className="text-fg-muted">{pendingApprovalEntry.description}</p>
            ) : null}
            <div>
              <p className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">
                Arguments
              </p>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface px-2.5 py-2 font-mono text-2xs text-fg">
                {formatSiteToolArguments(pendingApprovalRequest.arguments)}
              </pre>
            </div>
          </div>
        ) : null}
      </ConfirmDialog>
    </>
  );
}

export function formatSiteToolArguments(argumentsValue: Record<string, unknown>): string {
  return JSON.stringify(sortSiteToolJson(argumentsValue), null, 2) ?? "{}";
}

export function siteToolIsDestructive(entry: ToolGatewayCatalogEntry | null): boolean {
  return entry?.annotations?.destructiveHint === true;
}

function sortSiteToolJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortSiteToolJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortSiteToolJson(nested)]),
  );
}

type PendingToolApproval = {
  bridge: PublishedHtmlArtifactToolBridge;
  request: ToolGatewayCallRequest & { operationId: string };
  signal: AbortSignal;
  cleanup: () => void;
  resolve: (response: ToolGatewayCallResponse) => void;
  reject: (error: unknown) => void;
};

function useApprovedToolBridge(
  bridge: PublishedHtmlArtifactToolBridge | undefined,
  pendingApprovalRef: MutableRefObject<PendingToolApproval | null>,
  onApprovalRequested: (entry: ToolGatewayCatalogEntry | null) => void,
): PublishedHtmlArtifactToolBridge | undefined {
  return useMemo(() => {
    if (!bridge) return undefined;
    return {
      catalog: bridge.catalog,
      approve: bridge.approve,
      ...(bridge.declarations ? { declarations: bridge.declarations } : {}),
      call: async (request, options) => {
        const siteRequest = sanitizeOpenGeniSiteToolCallRequest(request);
        const catalog = await bridge.catalog(options);
        const entry = catalog.entries.find(
          (candidate) =>
            candidate.identity.serverId === siteRequest.identity.serverId &&
            candidate.identity.toolName === siteRequest.identity.toolName,
        );
        if (!entry) throw new Error("This tool is not available to the Site");
        if (pendingApprovalRef.current) {
          throw new Error("Another Site tool is waiting for approval");
        }
        if (options.signal.aborted) throw options.signal.reason;
        const approvalRequest = {
          ...siteRequest,
          operationId: siteRequest.operationId ?? crypto.randomUUID(),
        };
        return await new Promise<ToolGatewayCallResponse>((resolve, reject) => {
          const abort = () => {
            if (pendingApprovalRef.current?.request !== approvalRequest) return;
            pendingApprovalRef.current = null;
            onApprovalRequested(null);
            reject(options.signal.reason);
          };
          const cleanup = () => options.signal.removeEventListener("abort", abort);
          options.signal.addEventListener("abort", abort, { once: true });
          pendingApprovalRef.current = {
            bridge,
            request: approvalRequest,
            signal: options.signal,
            cleanup,
            resolve,
            reject,
          };
          onApprovalRequested(entry);
        });
      },
    };
  }, [bridge, onApprovalRequested, pendingApprovalRef]);
}

function rejectPendingApproval(
  pendingApprovalRef: MutableRefObject<PendingToolApproval | null>,
  message: string,
): void {
  const pending = pendingApprovalRef.current;
  if (!pending) return;
  pending.cleanup();
  pendingApprovalRef.current = null;
  pending.reject(new Error(message));
}
