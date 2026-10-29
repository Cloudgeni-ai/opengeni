import {
  readSitePermissions,
  removeSitePermissionEntry,
  renderSitePermissions,
} from "./site-permission-list";
import { SITE_PERMISSION_LABELS, type SitePermissionRequest } from "./site-permissions";

const ask = document.querySelector<HTMLElement>("[data-ask]")!;
const request = document.querySelector<HTMLElement>("[data-request]")!;
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
  request.hidden = !state.request;
  request.textContent = state.request ? requestText(state.request) : "";
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

/** What the agent that opened this page asked for. */
function requestText(asked: SitePermissionRequest): string {
  const verb = { granted: "allow", denied: "block", prompt: "reset" }[asked.setting];
  const what = SITE_PERMISSION_LABELS[asked.permission].toLowerCase();
  return `An agent asked to ${verb} ${what} for ${asked.origin}. Nothing changes until you allow it.`;
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
