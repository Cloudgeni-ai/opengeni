import type { PluginUninstallPreview, UninstallPluginResult } from "@opengeni/sdk";

/** Describe committed retention, not the package's pre-removal component count. */
export function pluginRemovalMessage(
  result: UninstallPluginResult,
  preview: PluginUninstallPreview,
): string {
  const retained = new Set(result.retainedComponents);
  const preserved = new Set(
    result.skillReleases
      ?.filter((release) => release.disposition === "preserved")
      .map((release) => release.skillId),
  );
  const names = [
    ...new Set(
      preview.components
        .filter(
          (component) =>
            retained.has(component.capabilityId) ||
            (component.skillId && preserved.has(component.skillId)),
        )
        .map((component) => component.name),
    ),
  ];
  if (!names.length) return "Your connected accounts are unchanged.";
  const visible = names.slice(0, 3).join(", ");
  const remainder = names.length > 3 ? ` and ${names.length - 3} more` : "";
  return `${visible}${remainder} ${names.length === 1 ? "was" : "were"} kept. Your connected accounts are unchanged.`;
}
