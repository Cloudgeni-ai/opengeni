import { expect, test } from "bun:test";
import {
  currentSiteSessionOrigin,
  sessionCreationMetadata,
  siteOriginsMatch,
  siteSessionOriginFromMetadata,
  withSiteOriginMetadata,
  withSiteSessionOrigin,
} from "../src/site-session-origin";

test("only resolved request origin is recorded, without changing user metadata", async () => {
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

test("published versions and inline frames are recorded additively", () => {
  const published = { siteId: "site-a", title: "A", versionId: "version-1" };
  expect(withSiteSessionOrigin(published, () => sessionCreationMetadata({ x: 1 }))).toEqual({
    x: 1,
    _opengeniSiteOrigin: published,
  });
  const inline = { siteId: null, title: "", frame: "inline" as const, frameId: "frame-1" };
  expect(withSiteSessionOrigin(inline, () => currentSiteSessionOrigin())).toEqual(inline);
  expect(withSiteOriginMetadata({ _opengeniSiteOrigin: { siteId: "forged" }, y: 2 }, null)).toEqual(
    { y: 2 },
  );
});

test("recorded origins parse leniently so any record marks a Site session", () => {
  expect(siteSessionOriginFromMetadata({})).toBeNull();
  expect(siteSessionOriginFromMetadata(null)).toBeNull();
  expect(siteSessionOriginFromMetadata({ _opengeniSiteOrigin: "x" })).toBeNull();
  expect(siteSessionOriginFromMetadata({ _opengeniSiteOrigin: {} })).toEqual({
    siteId: null,
    title: "",
  });
  expect(
    siteSessionOriginFromMetadata({
      _opengeniSiteOrigin: { siteId: "s", title: "T", versionId: "v", frame: "x", frameId: "" },
    }),
  ).toEqual({ siteId: "s", title: "T", versionId: "v" });
});

test("a Site page reaches only sessions of the same Site or the same frame", () => {
  const siteA = { siteId: "a", title: "A" };
  const siteB = { siteId: "b", title: "B" };
  const frame1 = { siteId: null, title: "", frame: "inline" as const, frameId: "f1" };
  const frame2 = { siteId: null, title: "", frame: "inline" as const, frameId: "f2" };
  expect(siteOriginsMatch(siteA, { siteId: "a", title: "renamed", versionId: "v2" })).toBe(true);
  expect(siteOriginsMatch(siteA, siteB)).toBe(false);
  expect(siteOriginsMatch(siteA, null)).toBe(false);
  expect(siteOriginsMatch(siteA, frame1)).toBe(false);
  expect(siteOriginsMatch(frame1, { ...frame1 })).toBe(true);
  expect(siteOriginsMatch(frame1, frame2)).toBe(false);
  expect(siteOriginsMatch(frame1, siteA)).toBe(false);
  expect(siteOriginsMatch(frame1, undefined)).toBe(false);
  const anonymous = { siteId: null, title: "", frame: "inline" as const };
  expect(siteOriginsMatch(anonymous, { siteId: null, title: "" })).toBe(false);
});
