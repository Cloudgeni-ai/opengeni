import { describe, expect, test } from "bun:test";

import { personalOrganizationName } from "./personal-organization-name";

describe("personalOrganizationName", () => {
  test("uses the person's name", () => {
    expect(personalOrganizationName("  Anna Hansen ", "anna@example.com")).toBe("Anna Hansen");
  });

  test("falls back to the email's local part when the name is empty or is the email", () => {
    expect(personalOrganizationName("", "anna.hansen@example.com")).toBe("anna.hansen");
    expect(personalOrganizationName("anna@example.com", "anna@example.com")).toBe("anna");
    expect(personalOrganizationName(null, null)).toBe("Personal");
  });

  test("stays within the accepted length", () => {
    expect(Array.from(personalOrganizationName("é".repeat(200), null))).toHaveLength(120);
  });
});
