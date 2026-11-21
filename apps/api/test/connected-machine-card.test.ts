import { expect, test } from "bun:test";
import type { MachineView } from "@opengeni/contracts";
import {
  browserExtensionForAgents,
  connectedMachineCardReadyMessage,
} from "../src/mcp/connected-machine-card";

const opengeniBrowser = browserExtensionForAgents({ browserExtensionName: "Opengeni Browser" });

function machine(patch: Partial<MachineView>): MachineView {
  return {
    sandboxId: "s",
    enrollmentId: "e",
    scope: "user",
    name: "Mac mini",
    state: "online",
    active: false,
    isSessionGroup: false,
    os: "macos",
    ...patch,
  } as MachineView;
}

test("a ready result names each computer the person can use with its state", () => {
  const message = connectedMachineCardReadyMessage(
    [
      machine({ isSessionGroup: true, name: "Cloud sandbox" }),
      machine({}),
      machine({ name: "Build box", scope: "workspace", state: "offline", active: true }),
    ],
    opengeniBrowser,
  );
  expect(message).toBe(
    "The Connected Machine card is in this chat. The person's connected computers: Mac mini (personal, online); Build box (shared in this workspace, offline, this chat runs on it). This doesn't show which computer the person is using right now. If they mean that one and it isn't listed, it isn't connected: say so and name the computers that are, instead of quietly using another one. Do not describe the card's buttons or steps. Chrome on a connected computer also needs the Opengeni Browser extension (https://chromewebstore.google.com/detail/opengeni-browser/phpmmcbeelfkcinjfbbggegjdcdmnnch).",
  );
  // Whether this app can connect another computer depends on the app and the
  // device, so the result doesn't promise it.
  expect(message).not.toContain("connect another");
});

test("without any computer of the person's, nothing is ready for them", () => {
  const message = connectedMachineCardReadyMessage([], opengeniBrowser);
  expect(message).toContain("None of the person's own computers is connected here");
  expect(connectedMachineCardReadyMessage(null, opengeniBrowser)).toContain(
    "couldn't be read just now",
  );
});

test("the extension is the deployment's own, linked only when the link is for it", () => {
  expect(
    browserExtensionForAgents({ browserExtensionName: "Opengeni Browser" }).installUrl,
  ).toContain("chromewebstore.google.com");
  expect(
    browserExtensionForAgents({
      browserExtensionName: "Acme Browser",
      browserExtensionInstallUrl: "https://example.com/acme-browser",
    }),
  ).toEqual({ name: "Acme Browser", installUrl: "https://example.com/acme-browser" });
  // Renamed without its own install page: no other product's link.
  const renamed = browserExtensionForAgents({ browserExtensionName: "Acme Browser" });
  expect(renamed).toEqual({ name: "Acme Browser", installUrl: null });
  const message = connectedMachineCardReadyMessage([machine({})], renamed);
  expect(message).toEndWith(
    "Chrome on a connected computer also needs the Acme Browser extension.",
  );
  expect(message).not.toContain("chromewebstore");
});
