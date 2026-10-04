import { expect, test } from "bun:test";

const newSession = await Bun.file(new URL("./sessions-index.tsx", import.meta.url)).text();
// The schedule form (with its connection-account picker) lives in components/schedules.
const schedules = await Bun.file(
  new URL("../components/schedules/schedule-form-page.tsx", import.meta.url),
).text();

test("new-session connector menu and notice distinguish denied access from a retryable failure", () => {
  expect(newSession).toContain("accessDenied: connectionAccounts.accessDenied,");
  expect(newSession).toContain("accountsFailure && !connectionAccounts.accessDenied ? (");
  // A transient outage shows the updating notice instead (see transient-retry).
  expect(newSession).toContain(
    "connectionAccounts.error !== null && !connectionAccounts.unavailable",
  );
  expect(newSession).toMatch(
    /accountsFailure\s*\? connectionAccounts\.accessDenied\s*\? connectionAccounts\.error\s*: "Couldn't send your message\. Try again\."/,
  );
});

test("schedule connection-account denial shows guidance without retrying a forbidden request", () => {
  expect(schedules).toMatch(
    /\{connectionAccounts\.error \? \(\s*<Notice\s+tone="failed"\s+action=\{\s*connectionAccounts\.accessDenied \? undefined : \(/,
  );
  expect(schedules).toContain("{connectionAccounts.error}");
});
