import { expect, test } from "bun:test";
import { nativeComputerEnvironment } from "../src";

test("native Computer helpers receive GUI state without cloud credentials", () => {
  expect(
    nativeComputerEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/workspace",
      DISPLAY: ":42",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus",
      LC_MESSAGES: "en_US.UTF-8",
      OPENGENI_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      AZURE_CLIENT_SECRET: "secret",
      MALFORMED: "nul\0value",
    }),
  ).toEqual({
    PATH: "/usr/bin:/bin",
    HOME: "/workspace",
    DISPLAY: ":42",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/bus",
    LC_MESSAGES: "en_US.UTF-8",
  });
});
