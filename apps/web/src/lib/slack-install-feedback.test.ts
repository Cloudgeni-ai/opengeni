import { slackSettingsSearch } from "./slack-settings-search";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { clearSlackInstallResult, slackInstallFeedback } from "./slack-install-feedback";
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3000" }));
afterAll(() => GlobalRegistrator.unregister());

test("conflicts and permission failures do not send users into a retry loop", () => {
  expect(slackInstallFeedback("http_409").retryable).toBe(false);
  expect(slackInstallFeedback("http_403").retryable).toBe(false);
  expect(slackInstallFeedback("provider_denied").retryable).toBe(true);
  expect(slackInstallFeedback("arbitrary-query-payload").description).not.toContain(
    "arbitrary-query-payload",
  );
});

test("legacy redirect preserves only bounded Slack display fields", () => {
  expect(
    slackSettingsSearch({
      slack: "error",
      reason: "http_409",
      integration: "slack",
      arbitrary: "discard",
    }),
  ).toEqual({ slack: "error", reason: "http_409", integration: "slack" });
  expect(slackSettingsSearch({ slack: "error", reason: "x".repeat(10000) })).toEqual({
    slack: "error",
    reason: "installation_failed",
  });
  expect(slackSettingsSearch({ slack: "unexpected", connectionId: "invalid" })).toEqual({});
});

test("dismissing the Slack result preserves unrelated navigation state", () => {
  window.history.replaceState(
    { retained: true },
    "",
    "/workspaces/example/plugins?integration=slack&slack=error&reason=http_409&section=packs#details",
  );
  clearSlackInstallResult();
  expect(window.location.search).toBe("?integration=slack&section=packs");
  expect(window.location.hash).toBe("#details");
  expect(window.history.state).toEqual({ retained: true });
});
