import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BrainCircuitIcon,
  Building2Icon,
  Code2Icon,
  CreditCardIcon,
  CpuIcon,
  DatabaseIcon,
  LayoutDashboardIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { BrandMark } from "@/components/brand-mark";
import type { OrganizationAdminSection } from "@/lib/organization-admin";
import { cn } from "@/lib/utils";

type OrganizationSettingsItem = {
  id: OrganizationAdminSection;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const ITEMS: readonly OrganizationSettingsItem[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboardIcon },
  { id: "knowledge", label: "Knowledge", icon: BrainCircuitIcon },
  { id: "models", label: "Models", icon: CpuIcon },
  { id: "people", label: "People & invitations", icon: UsersIcon },
  { id: "recovery", label: "Recovery", icon: ShieldCheckIcon },
  { id: "retention", label: "Retention", icon: DatabaseIcon },
  { id: "developer", label: "Developer", icon: Code2Icon },
  { id: "billing", label: "Billing", icon: CreditCardIcon },
];

const COPY: Record<OrganizationAdminSection, { title: string; description: string }> = {
  overview: {
    title: "Overview",
    description: "Identity, workspaces, access, and organization-wide session policy.",
  },
  knowledge: {
    title: "Knowledge",
    description:
      "Set the small identity agents always know and explore company knowledge they retrieve when relevant.",
  },
  models: {
    title: "Models",
    description: "Connect organization-funded model subscriptions inherited by shared workspaces.",
  },
  people: {
    title: "People & invitations",
    description: "Manage organization membership, roles, invitations, and workspace access.",
  },
  recovery: {
    title: "Recovery",
    description: "Configure recovery custody and review protected co-owner promotion operations.",
  },
  retention: {
    title: "Retention",
    description: "Control how long organization data is retained.",
  },
  developer: {
    title: "Developer",
    description: "Connect your product to every organization workspace.",
  },
  billing: {
    title: "Billing",
    description: "Credits, usage, plan entitlements, and payment settings.",
  },
};

export function OrganizationSettingsShell({
  workspaceId,
  organizationLabel,
  section,
  showModels,
  children,
}: {
  workspaceId: string;
  organizationLabel: string;
  section: OrganizationAdminSection;
  showModels: boolean;
  children: ReactNode;
}) {
  const copy = COPY[section];
  return (
    <div
      data-workspace-scroll-owner="self-managed"
      className="h-dvh overflow-x-hidden overflow-y-auto overscroll-y-contain bg-bg text-fg lg:grid lg:min-h-0 lg:grid-cols-[15rem_minmax(0,1fr)] lg:overflow-hidden"
    >
      <a
        href="#organization-settings-content"
        className="sr-only z-50 rounded-md bg-bg px-3 py-2 text-sm font-medium text-fg focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus-visible:ring-2 focus-visible:ring-brand"
      >
        Skip to organization settings
      </a>
      <aside className="border-b border-border bg-surface/35 lg:sticky lg:top-0 lg:h-dvh lg:min-h-0 lg:overflow-y-auto lg:overscroll-y-contain lg:border-r lg:border-b-0">
        <div className="flex h-full min-h-0 flex-col px-3 py-3 lg:py-4">
          <Link
            to="/workspaces/$workspaceId/sessions"
            params={{ workspaceId }}
            className="flex h-9 items-center gap-2 rounded-md px-2 text-sm font-semibold text-fg transition-colors hover:bg-surface-2"
          >
            <span className="flex size-6 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
              <BrandMark className="size-4" />
            </span>
            OpenGeni
          </Link>

          <Link
            to="/workspaces/$workspaceId/sessions"
            params={{ workspaceId }}
            className="mt-3 inline-flex h-8 items-center gap-2 rounded-md px-2 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg lg:mt-5"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
            Back to sessions
          </Link>

          <div className="mt-4 min-w-0 px-2 lg:mt-6">
            <p className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Organization
            </p>
            <div className="mt-2 flex min-w-0 items-center gap-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-brand/20 bg-brand/10 text-brand">
                <Building2Icon aria-hidden="true" className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-base font-semibold leading-tight">
                  {organizationLabel}
                </p>
                <p className="mt-0.5 text-2xs text-fg-subtle">Settings and governance</p>
              </div>
            </div>
          </div>

          <nav
            aria-label="Organization settings"
            className="mt-3 grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4 lg:flex lg:flex-col"
          >
            {ITEMS.filter((item) => item.id !== "models" || showModels).map((item) => {
              const Icon = item.icon;
              const selected = item.id === section;
              return (
                <Link
                  key={item.id}
                  to="/workspaces/$workspaceId/organization"
                  params={{ workspaceId }}
                  search={{ section: item.id }}
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    "flex h-9 min-w-0 items-center gap-2 border-l-2 px-2.5 text-sm transition-colors lg:w-full",
                    selected
                      ? "border-brand bg-brand/10 font-medium text-fg"
                      : "border-transparent text-fg-muted hover:border-border-strong hover:bg-surface-2/65 hover:text-fg",
                  )}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      </aside>

      <main
        id="organization-settings-content"
        className="min-w-0 px-4 py-7 sm:px-8 lg:min-h-0 lg:overflow-y-auto lg:px-12 lg:py-10"
      >
        <div className="mx-auto max-w-5xl">
          <header className="border-b border-border pb-5">
            <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.14em] text-brand">
              {organizationLabel}
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
            <p className="mt-1.5 text-sm text-fg-muted">{copy.description}</p>
          </header>
          <div className="py-6">{children}</div>
        </div>
      </main>
    </div>
  );
}
