type Status = {
  connected: boolean;
  deviceId: string | null;
  profileLabel: string | null;
  error: string | null;
};

const state = document.querySelector<HTMLElement>("[data-state]")!;
const detail = document.querySelector<HTMLElement>("[data-detail]")!;
const label = document.querySelector<HTMLInputElement>("[data-profile-label]")!;
const form = document.querySelector<HTMLFormElement>("form")!;
const save = document.querySelector<HTMLButtonElement>("button")!;

async function refresh(): Promise<void> {
  const status = (await chrome.runtime.sendMessage({ type: "status" })) as Status;
  document.body.dataset.connected = String(status.connected);
  state.textContent = status.connected ? "Connected" : "Agent unavailable";
  detail.textContent = status.connected
    ? "This Chrome profile is ready in OpenGeni. Tabs attach only when an agent uses them."
    : (status.error ?? "Start the OpenGeni machine agent to connect this profile.");
  label.value = status.profileLabel ?? "";
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  save.disabled = true;
  void chrome.runtime
    .sendMessage({ type: "set_profile_label", profileLabel: label.value })
    .then(refresh)
    .finally(() => {
      save.disabled = false;
    });
});

void refresh();
