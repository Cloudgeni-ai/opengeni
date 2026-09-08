import { expect, test } from "bun:test";
import { sessionCreationMetadata, withSiteSessionOrigin } from "../src/site-session-origin";

test("only trusted request origin is recorded, without changing user metadata", async () => {
  const metadata = { custom: "value", _opengeniSiteOrigin: { siteId: "forged" } };
  expect(sessionCreationMetadata(metadata)).toEqual({ custom: "value" });
  const first = { siteId: "first", title: "First" };
  const second = { siteId: "second", title: "Second" };
  const results = await Promise.all(
    [first, second].map((origin) =>
      withSiteSessionOrigin(origin, async () => {
        await Promise.resolve();
        return sessionCreationMetadata(metadata);
      }),
    ),
  );
  expect(results).toEqual(
    [first, second].map((origin) => ({ custom: "value", _opengeniSiteOrigin: origin })),
  );
  expect(sessionCreationMetadata({})).toEqual({});
  expect(metadata._opengeniSiteOrigin.siteId).toBe("forged");
});
