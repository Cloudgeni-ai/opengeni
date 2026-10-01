import { expect, test } from "bun:test";
import { parseOpenGeniLink } from "@opengeni/sdk";
import { consoleLinkResolver } from "./session-artifact-navigation";

test("console resolver preserves only validated session-return context", () => {
  const path = "/workspaces/ws/artifacts/editable/0123456789abcdef0123456789abcdef";
  const session = "11111111-1111-4111-8111-111111111111";
  expect(consoleLinkResolver(parseOpenGeniLink(`${path}?fromSession=${session}`)!)).toEqual({
    href: `${path}?fromSession=${session}`,
  });
  expect(parseOpenGeniLink(`${path}?fromSession=${session}?version=2`)).toBeNull();
  expect(parseOpenGeniLink(`${path}?fromSession=not-a-session`)).toBeNull();
});
