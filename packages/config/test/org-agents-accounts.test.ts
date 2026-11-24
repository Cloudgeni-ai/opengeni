import { expect, test } from "bun:test";
import { getSettings, orgAgentsEnabledForAccount } from "../src";

const LISTED = "62a3170f-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

function enabled(value: string | undefined, accountId: string | null) {
  const env = value === undefined ? {} : { OPENGENI_ORG_AGENTS_ACCOUNT_IDS: value };
  return orgAgentsEnabledForAccount(getSettings(env), accountId);
}

test("Console agents are off for every organization by default and when empty", () => {
  for (const value of [undefined, "", " , "]) {
    expect(enabled(value, LISTED)).toBe(false);
    expect(enabled(value, OTHER)).toBe(false);
  }
});

test("an explicit list turns Console agents on only for listed organizations", () => {
  const value = ` ${LISTED.toUpperCase()} `;
  expect(getSettings({ OPENGENI_ORG_AGENTS_ACCOUNT_IDS: value }).orgAgentsAccountIds).toEqual([
    LISTED,
  ]);
  expect(enabled(value, LISTED)).toBe(true);
  expect(enabled(value, LISTED.toUpperCase())).toBe(true);
  expect(enabled(value, OTHER)).toBe(false);
  expect(enabled(value, null)).toBe(false);
});

test("* turns Console agents on for every organization", () => {
  for (const value of ["*", " * ", `${LISTED},*`]) {
    expect(enabled(value, LISTED)).toBe(true);
    expect(enabled(value, OTHER)).toBe(true);
    expect(enabled(value, null)).toBe(false);
    expect(enabled(value, undefined as unknown as null)).toBe(false);
  }
});

test("values that are neither ids nor * are rejected", () => {
  for (const value of ["all", "**", "not-a-uuid", `${LISTED},all`]) {
    expect(() => getSettings({ OPENGENI_ORG_AGENTS_ACCOUNT_IDS: value })).toThrow();
  }
});
