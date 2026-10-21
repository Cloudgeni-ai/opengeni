import { expect, test } from "bun:test";
import { unavailableSessionMcpServerIds } from "./session-tools";

test("a saved draft drops retired tools without dropping runtime infrastructure or reconnectable accounts", () => {
  expect(
    unavailableSessionMcpServerIds(
      ["opengeni", "files", "retired-mail", "mail", "disabled-drive", "retired-mail"],
      [
        { id: "files", name: "Files" },
        { id: "mail", name: "Mail", connectionStatus: "reconnect" },
        { id: "disabled-drive", name: "Drive", connectionStatus: "unavailable" },
        { id: "new-calendar", name: "Calendar", connectionStatus: "ready" },
      ],
      true,
    ),
  ).toEqual(["retired-mail", "disabled-drive"]);
});

test("a failed catalog read cannot remove saved tool selections", () => {
  expect(unavailableSessionMcpServerIds(["mail", "calendar"], [], false)).toEqual([]);
});
