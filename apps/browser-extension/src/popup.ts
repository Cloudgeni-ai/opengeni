import { BRAND } from "./brand";
import {
  readSitePermissions,
  removeSitePermissionEntry,
  renderSitePermissions,
} from "./site-permission-list";

type Status = {
  connected: boolean;
  deviceId: string | null;
  profileLabel: string | null;
  error: string | null;
  /** Short headline, when not connected. */
  title?: string | null;
  /** What to do about it, when not connected. */
  detail?: string | null;
};

const state = document.querySelector<HTMLElement>("[data-state]")!;
const detail = document.querySelector<HTMLElement>("[data-detail]")!;
const label = document.querySelector<HTMLInputElement>("[data-profile-label]")!;
const form = document.querySelector<HTMLFormElement>("form")!;
const save = form.querySelector<HTMLButtonElement>("button")!;
const sitePermissions = document.querySelector<HTMLElement>("[data-site-permissions]")!;
const siteEntries = sitePermissions.querySelector<HTMLElement>("[data-entries]")!;
const siteEmpty = sitePermissions.querySelector<HTMLElement>("[data-empty]")!;
const siteStale = sitePermissions.querySelector<HTMLElement>("[data-stale]")!;
const manageSitePermissions = sitePermissions.querySelector<HTMLButtonElement>("[data-manage]")!;

/** How often the open popup re-reads the connection state. */
const STATUS_REFRESH_MS = 1000;

async function refresh(options: { label: boolean }): Promise<void> {
  const status = (await chrome.runtime.sendMessage({ type: "status" })) as Status;
  document.body.dataset.connected = String(status.connected);
  state.textContent = status.connected ? "Connected" : (status.title ?? "Runner unavailable");
  detail.textContent = status.connected
    ? `This Chrome profile is ready in ${BRAND.product}. Tabs attach only when an agent uses them.`
    : (status.detail ??
      status.error ??
      `Start ${BRAND.product} Runner on this computer to connect this profile.`);
  detail.title = status.connected ? "" : (status.error ?? "");
  // Only fill the label on open and after saving, so a refresh never
  // overwrites what the person is typing.
  if (options.label) label.value = status.profileLabel ?? "";
  await refreshSitePermissions();
}

/** Shown once the person allowed agents to set site permissions, or while
 * changes from before are still in effect. */
async function refreshSitePermissions(): Promise<void> {
  const sites = await readSitePermissions();
  sitePermissions.hidden = !sites.allowed && sites.entries.length === 0;
  siteEmpty.hidden = sites.entries.length > 0;
  // Removed outside this extension's own Turn off (on chrome://extensions):
  // the changes stay, and only allowing it again lets them be removed.
  siteStale.hidden = sites.allowed || sites.entries.length === 0;
  renderSitePermissions(siteEntries, sites.entries, {
    canRemove: sites.allowed,
    onRemove: async (entry) => {
      await removeSitePermissionEntry(entry);
      await refreshSitePermissions();
    },
  });
}

manageSitePermissions.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "open_site_permissions" }).then(() => window.close());
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  save.disabled = true;
  void chrome.runtime
    .sendMessage({ type: "set_profile_label", profileLabel: label.value })
    .then(() => refresh({ label: true }))
    .finally(() => {
      save.disabled = false;
    });
});

// The connection can change while the popup is open (the agent starts, the
// native host finishes its handshake, or the agent stops), so keep the shown
// state current instead of freezing the state from the moment it opened.
void refresh({ label: true }).finally(() => {
  setInterval(() => void refresh({ label: false }).catch(() => undefined), STATUS_REFRESH_MS);
});
