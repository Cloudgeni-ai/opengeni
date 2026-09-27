import { BookOpenIcon, BoxesIcon, Loader2Icon, RefreshCwIcon, TrashIcon } from "lucide-react";

import type { BundleRow } from "@/components/capabilities/bundles";
import {
  CapabilityAside,
  CapabilityMark,
  CapabilityPage,
  TechnicalDetails,
} from "@/components/capabilities/capability-page";
import type { IntegrationViewModel } from "@/components/capabilities/integration-view-model";
import { humanizeName } from "@/components/capabilities/skill-copy";
import { MoreMenu, RowButton } from "@/components/models/models-ui";
import { DetailSection } from "@/components/ui/detail-sheet";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Notice } from "@/components/ui/notice";

/* ----------------------------------------------------------------------------
   An imported skill or plugin, managed as an installation: what it is, where
   it came from, Check for update and Remove. Pinned versions and digests sit
   in Technical details.
   -------------------------------------------------------------------------- */

export function InstalledPackagePage({
  row,
  model,
  onBack,
  backLabel,
}: {
  row: BundleRow;
  model: IntegrationViewModel;
  onBack: () => void;
  backLabel?: string;
}) {
  const title = humanizeName(model.name);
  const kind = row.kind === "plugin" ? "Plugin" : "Skill";
  const source = model.connection.find((fact) => fact.label === "Source")?.value ?? null;
  const footer = model.footer;
  const actions =
    footer.kind === "actions" ? (
      <>
        {footer.primary ? (
          <RowButton
            disabled={footer.primary.disabled || footer.busy}
            title={footer.primary.unavailableReason}
            onClick={footer.primary.onClick}
          >
            {footer.busy ? (
              <Loader2Icon className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCwIcon aria-hidden="true" />
            )}
            Check for update
          </RowButton>
        ) : null}
        {footer.secondary ? (
          <MoreMenu label={`More actions for ${title}`}>
            <DropdownMenuItem
              variant="destructive"
              disabled={footer.secondary.disabled || footer.busy}
              onSelect={footer.secondary.onClick}
            >
              <TrashIcon />
              {`Remove ${kind.toLowerCase()}`}
            </DropdownMenuItem>
          </MoreMenu>
        ) : null}
      </>
    ) : undefined;
  return (
    <CapabilityPage
      onBack={onBack}
      backLabel={backLabel}
      mark={
        <CapabilityMark
          name={title}
          icon={row.kind === "plugin" ? <BoxesIcon /> : <BookOpenIcon />}
        />
      }
      title={title}
      status={model.chip.label}
      meta={[kind, source ? `From ${source}` : "Imported from a source"]}
      actions={actions}
      aside={
        <CapabilityAside
          name={title}
          items={[
            { label: "Kind", value: kind },
            source ? { label: "Source", value: source } : null,
            { label: "Available to", value: "Everyone in this workspace" },
          ]}
        />
      }
    >
      {model.notice ? (
        <DetailSection>
          <Notice tone={model.notice.tone} title={model.notice.title}>
            {model.notice.description}
          </Notice>
        </DetailSection>
      ) : null}
      <DetailSection title="About">
        <p className="m-0 text-sm leading-6 text-fg">
          {model.description ||
            (row.kind === "plugin"
              ? "A bundle of skills and connections."
              : "Instructions agents load when they need them.")}
        </p>
        {footer.kind === "locked" ? (
          <p className="mt-3 mb-0 text-xs leading-4.5 text-fg-muted">
            Only workspace admins can update and remove imported skills and plugins.
          </p>
        ) : null}
      </DetailSection>
      <TechnicalDetails
        facts={model.connection
          .filter((fact) => fact.label !== "Source")
          .map((fact) => ({
            label: fact.label,
            value: fact.value,
            mono: /digest|version/i.test(fact.label),
          }))}
      />
    </CapabilityPage>
  );
}
