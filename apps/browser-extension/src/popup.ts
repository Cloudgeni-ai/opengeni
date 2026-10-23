import { BRAND } from "./brand";

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
const save = document.querySelector<HTMLButtonElement>("button")!;

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
}

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
