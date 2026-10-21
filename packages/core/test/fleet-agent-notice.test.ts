import { describe, expect, test } from "bun:test";
import { fleetAgentNotice, type FleetListResult, type FleetSandboxEntry } from "../src";

function entry(name: string, liveness: FleetSandboxEntry["liveness"], isSessionGroup = false) {
  return { name, liveness, isSessionGroup } as FleetSandboxEntry;
}

function fleet(sandboxes: FleetSandboxEntry[]): FleetListResult {
  return { activeSandboxId: null, activeEpoch: 0, sandboxes };
}

describe("sandboxes_list notice", () => {
  test("covers a computer the person means that is not in the list", () => {
    expect(
      fleetAgentNotice(fleet([entry("sandbox", "offline", true), entry("Mac mini", "online")])),
    ).toStartWith(
      "If the computer the person means is not in this list, it is not connected: before answering, call capability_authorization_request once",
    );
  });

  test("offers the connect card in one call when no machine is connected", () => {
    const notice = fleetAgentNotice(fleet([entry("sandbox", "online", true)]));
    expect(notice).toStartWith("None of the person's computers is connected.");
    expect(notice).toContain(
      "capability_authorization_request once with capabilityId api:connected-machine",
    );
    expect(notice).toContain("do not describe buttons, commands or install steps");
  });

  test("names offline machines and offers to reconnect them", () => {
    expect(
      fleetAgentNotice(fleet([entry("Mac mini", "online"), entry("Work laptop", "offline")])),
    ).toStartWith(
      "Work laptop is not online and cannot be used until it reconnects. If the person needs it or a computer not in this list, before answering, call",
    );
    expect(
      fleetAgentNotice(fleet([entry("A", "offline"), entry("B", "reconnecting")])),
    ).toStartWith(
      "A, B are not online and cannot be used until they reconnect. If the person needs one of them or",
    );
  });

  test("says a listed computer can be tried even before its owner allows this chat", () => {
    const allow = "just use it, and if it is not allowed yet, the chat shows the owner a card";
    expect(fleetAgentNotice(fleet([entry("Mac mini", "online")]))).toContain(allow);
    expect(
      fleetAgentNotice(fleet([entry("Mac mini", "online"), entry("Work laptop", "offline")])),
    ).toContain(allow);
    expect(fleetAgentNotice(fleet([entry("sandbox", "online", true)]))).not.toContain(allow);
  });
});
