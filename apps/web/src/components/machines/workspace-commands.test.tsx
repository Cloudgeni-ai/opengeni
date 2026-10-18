import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionCommandsPanel } from "@opengeni/react";
import { commandElapsed } from "./workspace-commands";

test("elapsed duration remains useful for long-lived commands", () => {
  const start = "2026-10-18T00:00:00Z";
  const now = Date.parse(start);
  expect(commandElapsed(start, now + 59_000)).toBe("59s");
  expect(commandElapsed(start, now + 3_600_000)).toBe("1h 0m");
  expect(commandElapsed(start, now + 183_600_000)).toBe("2d 3h");
  expect(commandElapsed(start, now - 5_000)).toBe("0s");
  expect(commandElapsed("invalid", now)).toBe("Duration unavailable");
});

test("shared commands panel provides truthful loading, empty, error and retry states", () => {
  const base = {
    commands: [],
    loading: false,
    error: null,
    cancel: async () => {},
    refresh: async () => {},
  };
  expect(renderToStaticMarkup(<SessionCommandsPanel commands={base} compact={false} />)).toContain(
    "No background commands running",
  );
  expect(
    renderToStaticMarkup(<SessionCommandsPanel commands={{ ...base, loading: true }} />),
  ).toContain("Loading commands");
  const failed = renderToStaticMarkup(
    <SessionCommandsPanel commands={{ ...base, error: new Error("offline") }} />,
  );
  expect(failed).toContain("Commands unavailable");
  expect(failed).toContain("Retry");
  expect(failed).not.toContain("No background commands running");
});
