import { expect, test } from "bun:test";

import { AuthApiError } from "../api";
import { organizationSetupErrorText } from "./organization-onboarding-panel";

const message =
  "Too many new organizations were created from your network in the last hour. Please try again later, or ask a teammate to invite you to their organization.";

test("organization setup shows the per-network rate-limit message from the server", () => {
  expect(
    organizationSetupErrorText(
      new AuthApiError(429, "organization_setup_rate_limited", null, message),
    ),
  ).toBe(message);
  // Other 429s keep the usual advice rather than echoing the server text.
  const other = organizationSetupErrorText(
    new AuthApiError(429, "limit_exceeded", null, "Server detail"),
  );
  expect(other).not.toBe("Server detail");
  expect(other.length).toBeGreaterThan(0);
});
