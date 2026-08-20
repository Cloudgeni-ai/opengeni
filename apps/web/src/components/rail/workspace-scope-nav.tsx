import { ChevronUpIcon, Layers3Icon } from "lucide-react";
import { useEffect, useRef } from "react";

import { useRail } from "@/components/rail/rail-context";
import { useAppContext } from "@/context";
import { hasAccountPermission, hasWorkspacePermission } from "@/lib/permissions";
import {
  resolveWorkspaceScopeContext,
  type WorkspaceScopeContext,
} from "@/lib/workspace-scope-context";
import { cn } from "@/lib/utils";

export type ScopeNavigationLink = {
  href: string;
  label: string;
  description: string;
};

export function WorkspaceScopeNav() {
  const rail = useRail();
  const context = useAppContext();
  const workspace =
    context.workspaces.find((candidate) => candidate.id === rail.workspaceId) ?? null;
  const scope = resolveWorkspaceScopeContext({
    workspace,
    workspaces: context.workspaces,
    accessContext: context.accessContext,
    managedSelfContext: context.managedSelfContext,
  });
  if (!scope) return null;

  const canOpenOrganization =
    hasAccountPermission(context.accessContext, scope.organizationId, "account:read") ||
    hasAccountPermission(context.accessContext, scope.organizationId, "billing:read");
  const links: ScopeNavigationLink[] = [
    ...(canOpenOrganization
      ? [
          {
            href: `/workspaces/${encodeURIComponent(scope.workspaceId)}/organization`,
            label: scope.organizationLabel,
            description: "Organization administration",
          },
        ]
      : []),
    {
      href: `/workspaces/${encodeURIComponent(scope.workspaceId)}/settings`,
      label: scope.workspaceLabel,
      description:
        scope.workspaceKind === "personal" ? "Personal workspace settings" : "Workspace settings",
    },
    ...(scope.personalWorkspaceId
      ? [
          {
            href: `/workspaces/${encodeURIComponent(scope.personalWorkspaceId)}/sessions`,
            label: "Personal",
            description:
              scope.workspaceKind === "personal"
                ? "Current owner-only workspace"
                : "Open your owner-only workspace",
          },
        ]
      : []),
  ];
  const resources: ScopeNavigationLink[] = [
    ...(hasWorkspacePermission(context.accessContext, scope.workspaceId, "variable-sets:list")
      ? [
          {
            href: `/workspaces/${encodeURIComponent(scope.workspaceId)}/variable-sets`,
            label: "Variable sets",
            description: "Organization, Workspace, or Only me",
          },
        ]
      : []),
    ...(hasWorkspacePermission(context.accessContext, scope.workspaceId, "rigs:use")
      ? [
          {
            href: `/workspaces/${encodeURIComponent(scope.workspaceId)}/rigs`,
            label: "Rigs",
            description: "Organization, Workspace, or Only me",
          },
        ]
      : []),
    ...(hasWorkspacePermission(context.accessContext, scope.workspaceId, "enrollments:read")
      ? [
          {
            href: `/workspaces/${encodeURIComponent(scope.workspaceId)}/machines`,
            label: "Machines",
            description: "Organization, Workspace, or Only me",
          },
        ]
      : []),
    ...(hasWorkspacePermission(context.accessContext, scope.workspaceId, "documents:search")
      ? [
          {
            href: `/workspaces/${encodeURIComponent(scope.workspaceId)}/documents`,
            label: "Documents",
            description: "Company, Workspace, or Only me",
          },
        ]
      : []),
  ];

  if (rail.isMobile) {
    return (
      <WorkspaceScopeNavigationContent
        scope={scope}
        links={links}
        resources={resources}
        className="mx-2 mb-2 rounded-lg border border-border bg-surface/45 p-2"
      />
    );
  }

  return (
    <WorkspaceScopeMenu
      scope={scope}
      links={links}
      resources={resources}
      collapsed={rail.collapsed}
    />
  );
}

export function WorkspaceScopeMenu(props: {
  scope: WorkspaceScopeContext;
  links: ScopeNavigationLink[];
  resources: ScopeNavigationLink[];
  collapsed: boolean;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const node = detailsRef.current;
    if (!node) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!node.open) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      node.open = false;
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  return (
    <details ref={detailsRef} className="group/scope-menu relative px-2">
      <summary
        aria-label={props.collapsed ? "Scope and access" : undefined}
        title={props.collapsed ? "Scope and access" : undefined}
        className={cn(
          "flex h-8 w-full cursor-pointer list-none items-center rounded-md text-sm font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none pointer-coarse:h-10 [&::-webkit-details-marker]:hidden",
          props.collapsed ? "w-8 justify-center pointer-coarse:w-10" : "gap-2.5 px-2.5",
        )}
      >
        <Layers3Icon aria-hidden="true" className="size-4 shrink-0" />
        {!props.collapsed ? (
          <>
            <span className="min-w-0 flex-1 truncate text-left">Scope &amp; access</span>
            <ChevronUpIcon className="size-3.5 shrink-0 rotate-180 text-fg-subtle transition-transform group-open/scope-menu:rotate-0" />
          </>
        ) : null}
      </summary>
      <WorkspaceScopeNavigationContent
        scope={props.scope}
        links={props.links}
        resources={props.resources}
        onNavigate={() => {
          if (detailsRef.current) detailsRef.current.open = false;
        }}
        className="absolute bottom-full left-2 z-50 mb-1.5 max-h-[min(36rem,75vh)] w-72 overflow-y-auto rounded-md border border-border bg-surface p-2 shadow-md"
      />
    </details>
  );
}

export function WorkspaceScopeNavigationContent(props: {
  scope: WorkspaceScopeContext;
  links: ScopeNavigationLink[];
  resources: ScopeNavigationLink[];
  className?: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Scope and access" className={props.className}>
      <p className="px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
        Current context
      </p>
      <p className="px-2 pb-2 text-xs text-fg-muted">
        {props.scope.workspaceKind === "personal"
          ? "Personal workspace inside this organization"
          : "Shared workspace inside this organization"}
      </p>
      <div className="grid gap-0.5">
        {props.links.map((link) => (
          <ScopeNavigationAnchor key={link.href} link={link} onNavigate={props.onNavigate} />
        ))}
      </div>
      {props.resources.length > 0 ? (
        <>
          <div className="my-2 h-px bg-border" />
          <p className="px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
            Scoped resources
          </p>
          <div className="grid gap-0.5">
            {props.resources.map((link) => (
              <ScopeNavigationAnchor key={link.href} link={link} onNavigate={props.onNavigate} />
            ))}
          </div>
        </>
      ) : null}
    </nav>
  );
}

function ScopeNavigationAnchor(props: { link: ScopeNavigationLink; onNavigate?: () => void }) {
  return (
    <a
      href={props.link.href}
      className="flex min-h-10 items-center rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-surface-2 focus-visible:bg-surface-2"
      style={{ display: "flex", minHeight: "40px" }}
      onClick={props.onNavigate}
    >
      <span className="min-w-0">
        <span className="block truncate font-medium text-fg">{props.link.label}</span>{" "}
        <span className="block truncate text-2xs text-fg-subtle">{props.link.description}</span>
      </span>
    </a>
  );
}
