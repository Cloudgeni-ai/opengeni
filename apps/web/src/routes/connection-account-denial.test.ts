import { expect, test } from "bun:test";

const newSession = await Bun.file(new URL("./sessions-index.tsx", import.meta.url)).text();
// The schedule form (with its connection-account picker) lives in components/schedules.
const schedules = await Bun.file(
  new URL("../components/schedules/schedule-form-page.tsx", import.meta.url),
).text();

test("new-session connector menu and notice distinguish denied access from a retryable failure", () => {
  expect(newSession).toContain("accessDenied: connectionAccounts.accessDenied,");
  expect(newSession).toContain("connectionAccounts.error && !connectionAccounts.accessDenied ? (");
  expect(newSession).toMatch(
    /connectionAccounts\.error\s*\? connectionAccounts\.accessDenied\s*\? connectionAccounts\.error\s*: "Couldn't check connected accounts\. Retry to send your message\."/,
  );
});

test("schedule connection-account denial shows guidance without retrying a forbidden request", () => {
  expect(schedules).toMatch(
    /\{connectionAccounts\.error \? \(\s*<Notice\s+tone="failed"\s+action=\{\s*connectionAccounts\.accessDenied \? undefined : \(/,
  );
  expect(schedules).toContain("{connectionAccounts.error}");
});
