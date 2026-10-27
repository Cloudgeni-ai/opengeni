import {
  readSitePermissions,
  removeSitePermissionEntry,
  renderSitePermissions,
} from "./site-permission-list";

const ask = document.querySelector<HTMLElement>("[data-ask]")!;
const allow = document.querySelector<HTMLButtonElement>("[data-allow]")!;
const manage = document.querySelector<HTMLElement>("[data-manage]")!;
const status = document.querySelector<HTMLElement>("[data-status]")!;
const entries = document.querySelector<HTMLElement>("[data-entries]")!;
const empty = document.querySelector<HTMLElement>("[data-empty]")!;
const turnOff = document.querySelector<HTMLButtonElement>("[data-turn-off]")!;

async function refresh(): Promise<void> {
  const state = await readSitePermissions();
  document.body.dataset.allowed = String(state.allowed);
  ask.hidden = state.allowed;
  manage.hidden = !state.allowed && state.entries.length === 0;
  turnOff.hidden = !state.allowed;
  empty.hidden = state.entries.length > 0;
  status.textContent = state.allowed
    ? "Allowed. Agents can now set these permissions for the site they have open."
    : "Not allowed now, but these earlier changes are still in effect. Allow again to remove them, or turn this extension off on chrome://extensions.";
  renderSitePermissions(entries, state.entries, {
    canRemove: state.allowed,
    onRemove: async (entry) => {
      await removeSitePermissionEntry(entry);
      await refresh();
    },
  });
}

// Chrome shows its confirmation only in answer to a click on this page.
allow.addEventListener("click", () => {
  allow.disabled = true;
  void chrome.permissions
    .request({ permissions: ["contentSettings"] })
    .catch(() => false)
    .finally(() => {
      allow.disabled = false;
      void refresh();
    });
});

turnOff.addEventListener("click", () => {
  turnOff.disabled = true;
  void chrome.runtime.sendMessage({ type: "turn_off_site_permissions" }).finally(() => {
    turnOff.disabled = false;
    void refresh();
  });
});

// Changes made elsewhere: by an agent, in the popup, or on chrome://extensions.
chrome.permissions.onAdded.addListener(() => void refresh());
chrome.permissions.onRemoved.addListener(() => void refresh());
chrome.storage.onChanged.addListener(() => void refresh());
void refresh();
