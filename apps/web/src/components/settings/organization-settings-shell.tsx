import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CreditCardIcon,
  DatabaseIcon,
  LayoutDashboardIcon,
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
  { id: "people", label: "People & invitations", icon: UsersIcon },
  { id: "retention", label: "Retention", icon: DatabaseIcon },
  { id: "billing", label: "Billing", icon: CreditCardIcon },
];

const COPY: Record<OrganizationAdminSection, { title: string; description: string }> = {
  overview: {
    title: "Organization overview",
    description: "Organization identity, access, and private-session policy.",
  },
  people: {
    title: "People & invitations",
    description: "Manage organization membership, roles, invitations, and workspace access.",
  },
  retention: {
    title: "Retention",
    description: "Control how long organization data is retained.",
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
  children,
}: {
  workspaceId: string;
  organizationLabel: string;
  section: OrganizationAdminSection;
  children: ReactNode;
}) {
  const copy = COPY[section];
  return (
    <div
      data-workspace-scroll-owner="self-managed"
      className="h-dvh overflow-x-hidden overflow-y-auto overscroll-y-contain bg-bg text-fg lg:grid lg:min-h-0 lg:grid-cols-[15rem_minmax(0,1fr)] lg:overflow-hidden"
    >
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
            <ArrowLeftIcon className="size-3.5" />
            Back to sessions
          </Link>

          <div className="mt-4 min-w-0 px-2 lg:mt-6">
            <p className="text-base font-semibold">Organization settings</p>
            <p className="mt-1 truncate text-xs text-fg-muted">{organizationLabel}</p>
          </div>

          <nav
            aria-label="Organization settings"
            className="mt-3 grid grid-cols-2 gap-1 sm:grid-cols-4 lg:flex lg:flex-col"
          >
            {ITEMS.map((item) => {
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
                    "flex h-9 min-w-0 items-center gap-2 rounded-md px-2.5 text-sm transition-colors lg:w-full",
                    selected
                      ? "bg-surface-3 font-medium text-fg"
                      : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      </aside>

      <div className="min-w-0 px-4 py-7 sm:px-8 lg:min-h-0 lg:overflow-y-auto lg:px-12 lg:py-10">
        <div className="mx-auto max-w-4xl">
          <header className="border-b border-border pb-5">
            <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
            <p className="mt-1.5 text-sm text-fg-muted">{copy.description}</p>
          </header>
          <div className="py-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
