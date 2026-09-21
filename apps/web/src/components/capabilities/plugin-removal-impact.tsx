import { BookOpenIcon, CableIcon, LinkIcon } from "lucide-react";
import type { PluginUninstallPreview } from "@/types";

type Component = PluginUninstallPreview["components"][number];

export function pluginRetentionReason(component: Component): string {
  const reasons: string[] = [];
  if (component.retentionReasons.includes("customized"))
    reasons.push("Customized in this workspace.");
  if (component.retentionReasons.includes("re_scoped"))
    reasons.push("Managed outside this workspace.");
  if (component.retentionReasons.includes("other_owners")) {
    const names = component.remainingOwners
      .filter((owner) => owner.kind === "plugin")
      .map((owner) => owner.name);
    if (names.length) reasons.push(`Also included in ${[...new Set(names)].join(", ")}.`);
    if (component.remainingOwners.some((owner) => owner.kind === "direct"))
      reasons.push("Also installed separately.");
    if (!names.length && !component.remainingOwners.some((owner) => owner.kind === "direct"))
      reasons.push("Another installation still includes this.");
  }
  if (component.retentionReasons.includes("registry_unavailable"))
    reasons.push("Skill status couldn’t be verified.");
  return reasons.join(" ");
}

export function PluginRemovalImpact({ preview }: { preview: PluginUninstallPreview }) {
  const groups = [
    { disposition: "removed", title: "Will be removed" },
    { disposition: "retained", title: "Will stay" },
    { disposition: "inactive", title: "Already inactive" },
  ] as const;
  return (
    <div className="space-y-5 text-left">
      <div
        className="max-h-[40dvh] space-y-5 overflow-y-auto overscroll-contain"
        tabIndex={0}
        role="region"
        aria-label="Removal details"
      >
        {groups.map(({ disposition, title }) => {
          const components = preview.components.filter(
            (component) => component.disposition === disposition,
          );
          if (!components.length) return null;
          return (
            <section key={disposition} aria-label={title}>
              <h3 className="mb-2 text-sm font-medium text-fg">{title}</h3>
              <ul className="space-y-3">
                {components.map((component) => {
                  const Icon = component.kind === "skill" ? BookOpenIcon : CableIcon;
                  return (
                    <li key={component.capabilityId} className="flex min-w-0 items-start gap-3">
                      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-muted" />
                      <div className="min-w-0 text-sm leading-5">
                        <p className="break-words text-fg">{component.name}</p>
                        <p className="break-words text-xs leading-5 text-fg-muted">
                          {disposition === "retained"
                            ? pluginRetentionReason(component)
                            : component.kind === "skill"
                              ? "Skill"
                              : "Tools"}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {!preview.components.length ? (
          <p className="text-sm text-fg-muted">
            This plugin has no installed skills or tools to remove.
          </p>
        ) : null}
      </div>
      <p className="flex items-start gap-2 border-t border-border pt-4 text-xs leading-5 text-fg-muted">
        <LinkIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        Your connected accounts will stay connected.
      </p>
    </div>
  );
}
