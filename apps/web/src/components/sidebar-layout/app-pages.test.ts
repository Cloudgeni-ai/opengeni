import { describe, expect, test } from "bun:test";
import { appPagePaths, typedPagePath } from "./app-pages";

describe("appPagePaths", () => {
  test("lists the app's own pages and declared routes", () => {
    const html = `
      <nav>
        <a href="/releases">Releases</a>
        <a href='#/board'>Board</a>
        <a href="./team.html">Team</a>
        <a href="settings?tab=1">Settings</a>
        <button data-route="/inbox"></button>
        <section data-page="/releases"></section>
      </nav>`;
    expect(appPagePaths(html)).toEqual([
      "/#/board",
      "/inbox",
      "/releases",
      "/settings",
      "/team.html",
    ]);
  });

  test("leaves out outside links, anchors, files and home", () => {
    const html = `
      <link href="/styles.css" rel="stylesheet">
      <a href="https://example.com/x">x</a>
      <a href="//cdn.example.com/y">y</a>
      <a href="mailto:a@b.c">mail</a>
      <a href="#top">top</a>
      <a href="/">home</a>
      <a href="/index.html">home</a>
      <a href="/report.pdf">pdf</a>`;
    expect(appPagePaths(html)).toEqual([]);
  });
});

describe("typedPagePath", () => {
  test("adds the leading slash and refuses what isn't a path", () => {
    expect(typedPagePath("releases")).toBe("/releases");
    expect(typedPagePath("/a/b")).toBe("/a/b");
    expect(typedPagePath("  ")).toBeNull();
    expect(typedPagePath("a b")).toBeNull();
  });
});
