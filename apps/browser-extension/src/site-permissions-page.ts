import {
  readSitePermissions,
  removeSitePermissionEntry,
  renderSitePermissions,
  sitePermissionRequestText,
} from "./site-permission-list";

const ask = document.querySelector<HTMLElement>("[data-ask]")!;
const request = document.querySelector<HTMLElement>("[data-request]")!;
const allow = document.querySelector<HTMLButtonElement>("[data-allow]")!;
const notNow = document.querySelector<HTMLButtonElement>("[data-not-now]")!;
const manage = document.querySelector<HTMLElement>("[data-manage]")!;
const status = document.querySelector<HTMLElement>("[data-status]")!;
const entries = document.querySelector<HTMLElement>("[data-entries]")!;
const empty = document.querySelector<HTMLElement>("[data-empty]")!;
const turnOff = document.querySelector<HTMLButtonElement>("[data-turn-off]")!;

async function refresh(): Promise<void> {
  const state = await readSitePermissions();
  document.body.dataset.allowed = String(state.allowed);
  ask.hidden = state.allowed;
  request.hidden = !state.request;
  request.textContent = state.request
    ? `${sitePermissionRequestText(state.request)} Nothing changes until you allow it.`
    : "";
  manage.hidden = !state.allowed && state.entries.length === 0;
  turnOff.hidden = !state.allowed;
  empty.hidden = state.entries.length > 0;
  status.textContent = state.allowed
    ? "Allowed. Agents can now set these permissions for the site in a tab they opened."
    : "Not allowed now, but these earlier changes are still in effect. Allow again to remove them.";
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

// The same as closing this tab: agents do not open it again.
notNow.addEventListener("click", () => {
  void chrome.tabs.getCurrent().then((tab) => {
    if (tab?.id !== undefined) void chrome.tabs.remove(tab.id);
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
