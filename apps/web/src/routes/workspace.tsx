// The workspace shell: header (brand, nav, workspace switcher, session
// status cluster) around every workspace-scoped route.
import { OpenGeniProvider, SessionStatus as SessionStatusBadge } from "@opengeni/react";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BotIcon,
  BoxIcon,
  CalendarClockIcon,
  FileSearchIcon,
  LockIcon,
  PackageIcon,
  PanelRightIcon,
  PlugIcon,
  SparkleIcon,
  UserIcon,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { toast } from "sonner";

import { ConnectionPill, ProblemPanel } from "@/components/common";
import { Button } from "@/components/ui/button";
import { useAppContext, workspaceLabel } from "@/context";
import { isAbortError } from "@/lib/session-tools";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/types";

export function WorkspaceShellRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeWorkspace = context.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  const isSessionRoute = /\/sessions\/[^/]+/.test(pathname);
  const previousWorkspaceId = useRef<string | null>(null);

  useEffect(() => {
    if (!activeWorkspace) {
      return;
    }
    const abortController = new AbortController();
    if (previousWorkspaceId.current !== workspaceId) {
      context.resetSessionView();
    }
    previousWorkspaceId.current = workspaceId;
    context.resetWorkspaceIntegrations();
    context.setSelectedRepoIds(new Set());
    context.setSelectedRepoRefs({});
    void context.refreshGitHub(workspaceId, abortController.signal);
    void context.refreshWorkspaceMcpServers(workspaceId, abortController.signal)
      .catch((error) => {
        if (!isAbortError(error)) {
          toast.error("Failed to load workspace MCP tools", { description: String(error) });
        }
      });
    return () => abortController.abort();
  }, [workspaceId, context.accessKeyVersion, activeWorkspace?.id]);

  if (!activeWorkspace) {
    return (
      <>
        <WorkspaceHeader workspaceId={workspaceId} activeWorkspace={null} isSessionRoute={false} onChangeWorkspace={changeWorkspace} />
        <ProblemPanel
          title="Workspace unavailable"
          description="The URL workspace is not available to this subject."
          action={<Button asChild type="button" variant="secondary"><Link to="/">Open default workspace</Link></Button>}
        />
      </>
    );
  }

  return (
    <OpenGeniProvider client={context.client} workspaceId={workspaceId}>
      <WorkspaceHeader workspaceId={workspaceId} activeWorkspace={activeWorkspace} isSessionRoute={isSessionRoute} onChangeWorkspace={changeWorkspace} />
      <Outlet />
    </OpenGeniProvider>
  );

  async function changeWorkspace(nextWorkspaceId: string) {
    context.resetSessionView();
    await navigate({ to: "/workspaces/$workspaceId/sessions", params: { workspaceId: nextWorkspaceId } });
  }
}

function WorkspaceHeader(props: {
  workspaceId: string;
  activeWorkspace: Workspace | null;
  isSessionRoute: boolean;
  onChangeWorkspace: (workspaceId: string) => void;
}) {
  const context = useAppContext();
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)]/75 px-3 backdrop-blur sm:gap-3 sm:px-6">
      <Button asChild type="button" variant="ghost" size="sm" className="h-9 shrink-0 px-1.5 text-[15px] font-medium">
        <Link to="/workspaces/$workspaceId/sessions" params={{ workspaceId: props.workspaceId }}>
          <span className="flex size-6 items-center justify-center rounded-md bg-[color:var(--color-brand-strong)]/20 text-[color:var(--color-brand)]">
            <SparkleIcon className="size-3.5" />
          </span>
          <span className="hidden lg:inline">OpenGeni</span>
        </Link>
      </Button>

      <nav className="flex min-w-0 items-center gap-1 overflow-x-auto rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)]/45 p-1">
        <NavButton to="/workspaces/$workspaceId/sessions" workspaceId={props.workspaceId} icon={<BotIcon className="size-3.5" />} label="Sessions" />
        <NavButton to="/workspaces/$workspaceId/environments" workspaceId={props.workspaceId} icon={<BoxIcon className="size-3.5" />} label="Environments" />
        <NavButton to="/workspaces/$workspaceId/packs" workspaceId={props.workspaceId} icon={<PackageIcon className="size-3.5" />} label="Packs" />
        <NavButton to="/workspaces/$workspaceId/capabilities" workspaceId={props.workspaceId} icon={<PlugIcon className="size-3.5" />} label="Capabilities" />
        <NavButton to="/workspaces/$workspaceId/schedules" workspaceId={props.workspaceId} icon={<CalendarClockIcon className="size-3.5" />} label="Schedules" />
        <NavButton to="/workspaces/$workspaceId/documents" workspaceId={props.workspaceId} icon={<FileSearchIcon className="size-3.5" />} label="Documents" />
        <NavButton to="/workspaces/$workspaceId/account" workspaceId={props.workspaceId} icon={<UserIcon className="size-3.5" />} label="Account" />
      </nav>

      {context.session && props.isSessionRoute ? (
        <div className="hidden min-w-0 items-center gap-2 xl:flex">
          <Button asChild type="button" variant="ghost" size="icon-sm" aria-label="Back to sessions">
            <Link to="/workspaces/$workspaceId/sessions" params={{ workspaceId: props.workspaceId }}>
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{context.session.initialMessage}</div>
            <div className="truncate text-xs text-[color:var(--color-fg-subtle)]">
              {context.session.model} · {String(context.session.metadata.reasoningEffort ?? "low")} · {context.session.sandboxBackend}
            </div>
          </div>
        </div>
      ) : null}

      <label className="ml-auto flex min-w-28 max-w-44 items-center gap-2 sm:min-w-40 sm:max-w-64">
        <span className="sr-only">Workspace</span>
        <select
          value={props.activeWorkspace?.id ?? props.workspaceId}
          onChange={(event) => props.onChangeWorkspace(event.target.value)}
          className="h-8 w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 text-xs text-[color:var(--color-fg)]"
        >
          {context.workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>{workspaceLabel(workspace, context.workspaces)}</option>
          ))}
        </select>
      </label>

      <div className="flex shrink-0 items-center gap-2">
        {context.keyAuthRequired ? (
          <Button type="button" variant="ghost" size="icon-sm" onClick={context.forgetAccessKey} aria-label="Clear access key">
            <LockIcon className="size-4" />
          </Button>
        ) : null}
        {context.session && props.isSessionRoute ? <ConnectionPill state={context.connectionState} /> : null}
        {context.session && props.isSessionRoute ? <SessionStatusBadge status={context.session.status} /> : null}
        {context.session && props.isSessionRoute ? (
          <Button
            type="button"
            variant={context.inspectorOpen ? "secondary" : "ghost"}
            size="icon-sm"
            onClick={() => context.setInspectorOpen((open) => !open)}
            aria-label="Toggle session rail"
          >
            <PanelRightIcon className="size-4" />
          </Button>
        ) : null}
      </div>
    </header>
  );
}

function NavButton(props: {
  to:
    | "/workspaces/$workspaceId/sessions"
    | "/workspaces/$workspaceId/environments"
    | "/workspaces/$workspaceId/packs"
    | "/workspaces/$workspaceId/capabilities"
    | "/workspaces/$workspaceId/schedules"
    | "/workspaces/$workspaceId/documents"
    | "/workspaces/$workspaceId/account";
  workspaceId: string;
  icon: ReactNode;
  label: string;
}) {
  return (
    <Link
      to={props.to}
      params={{ workspaceId: props.workspaceId }}
      activeProps={{ "data-active": "true" }}
      className={cn(
        "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-[color:var(--color-fg-muted)] transition-colors hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)]",
        "data-[active=true]:bg-[color:var(--color-surface-2)] data-[active=true]:text-[color:var(--color-fg)]",
      )}
    >
      {props.icon}
      <span className="hidden md:inline">{props.label}</span>
    </Link>
  );
}
