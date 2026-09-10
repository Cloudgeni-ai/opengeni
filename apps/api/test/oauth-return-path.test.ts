import { expect, test } from "bun:test";
import { safeReturnPath } from "../src/integrations/oauth-return-path";
test("provider consent can return to the exact conversation", () => {
  const path = "/workspaces/workspace/sessions/session?capability_auth=api%3Afiken";
  expect(safeReturnPath(path)).toBe(path);
});
for (const value of [
  "https://other.example/session",
  "//other.example",
  "/\\other.example",
  "/a/..//other.example",
]) {
  test(`rejects an off-origin or normalized protocol-relative return: ${value}`, () => {
    expect(() => safeReturnPath(value)).toThrow("relative path");
  });
}
