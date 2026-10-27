import {
  SITE_PERMISSION_LABELS,
  type SitePermissionEntry,
  type SitePermissionsState,
} from "./site-permissions";

export async function readSitePermissions(): Promise<SitePermissionsState> {
  return (await chrome.runtime.sendMessage({ type: "site_permissions" })) as SitePermissionsState;
}

export async function removeSitePermissionEntry(entry: SitePermissionEntry): Promise<void> {
  await chrome.runtime.sendMessage({
    type: "remove_site_permission",
    pattern: entry.pattern,
    permission: entry.permission,
  });
}

/** The changes agents made, each with Remove while the extension can still
 * undo it. Redraws only when the list changed, so a periodic refresh never
 * takes focus away from a button. */
export function renderSitePermissions(
  list: HTMLElement,
  entries: readonly SitePermissionEntry[],
  options: { canRemove: boolean; onRemove: (entry: SitePermissionEntry) => Promise<void> },
): void {
  const key = JSON.stringify([options.canRemove, entries]);
  if (list.dataset.rendered === key) return;
  list.dataset.rendered = key;
  list.replaceChildren(
    ...entries.map((entry) => {
      const item = document.createElement("li");
      const what = document.createElement("div");
      what.className = "what";
      const name = document.createElement("strong");
      const label = SITE_PERMISSION_LABELS[entry.permission];
      name.textContent = `${label} ${entry.setting === "granted" ? "allowed" : "blocked"}`;
      const site = document.createElement("span");
      site.className = "site";
      site.textContent = entry.origin;
      what.append(name, site);
      item.append(what);
      if (options.canRemove) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "secondary";
        remove.textContent = "Remove";
        remove.setAttribute("aria-label", `Remove ${label.toLowerCase()} for ${entry.origin}`);
        remove.addEventListener("click", () => {
          remove.disabled = true;
          void options.onRemove(entry).finally(() => {
            remove.disabled = false;
          });
        });
        item.append(remove);
      }
      return item;
    }),
  );
}
