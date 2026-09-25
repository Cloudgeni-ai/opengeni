import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  USER_CONTENT_SECURITY_HEADERS,
  USER_CONTENT_SECURITY_POLICY,
  USER_MEDIA_CONTENT_SECURITY_POLICY,
  isActiveUserContentType,
  isPlayableMediaUserContentType,
  userContentDispositionHeaders,
  userContentResponseHeaders,
  userContentSecurityPolicy,
} from "../src/http/user-content";

describe("user-content response headers", () => {
  test("sandbox every user-content document with no script or network capability", () => {
    const directives = USER_CONTENT_SECURITY_POLICY.split(";").map((part) => part.trim());
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain("sandbox");
    // Bare `sandbox` grants nothing: no scripts, forms, popups, or same-origin.
    expect(directives.some((directive) => directive.startsWith("sandbox "))).toBe(false);
    expect(USER_CONTENT_SECURITY_POLICY).not.toContain("script-src");
    expect(USER_CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(USER_CONTENT_SECURITY_HEADERS).toEqual({
      "Content-Security-Policy": USER_CONTENT_SECURITY_POLICY,
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
  });

  test("media keeps its origin for playback but never gains script capability", () => {
    const directives = USER_MEDIA_CONTENT_SECURITY_POLICY.split(";").map((part) => part.trim());
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain("sandbox allow-same-origin");
    expect(USER_MEDIA_CONTENT_SECURITY_POLICY).not.toContain("allow-scripts");
    for (const media of ["video/mp4", "video/webm", "audio/mpeg", "AUDIO/OGG; codecs=opus"]) {
      expect(isPlayableMediaUserContentType(media)).toBe(true);
      expect(userContentSecurityPolicy(media)).toBe(USER_MEDIA_CONTENT_SECURITY_POLICY);
      expect(userContentResponseHeaders(media, "clip")).toEqual({
        ...USER_CONTENT_SECURITY_HEADERS,
        "Content-Security-Policy": USER_MEDIA_CONTENT_SECURITY_POLICY,
      });
    }
    for (const other of [
      "text/html",
      "image/svg+xml",
      "video/x-markup+xml",
      "image/png",
      "application/pdf",
      "text/plain",
      "video",
    ]) {
      expect(isPlayableMediaUserContentType(other)).toBe(false);
      expect(userContentSecurityPolicy(other)).toBe(USER_CONTENT_SECURITY_POLICY);
    }
  });

  test("classifies markup a browser would render as an active document", () => {
    for (const active of [
      "text/html",
      "TEXT/HTML; charset=utf-8",
      "application/xhtml+xml",
      "image/svg+xml",
      "text/xml",
      "application/xml",
      "text/xsl",
      "application/mathml+xml",
      "application/rss+xml",
      "multipart/x-mixed-replace; boundary=x",
      "",
      "html",
      "text/html,text/plain",
    ]) {
      expect({ active, result: isActiveUserContentType(active) }).toEqual({
        active,
        result: true,
      });
    }
    for (const inline of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "video/mp4",
      "audio/mpeg",
      "application/pdf",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
      "application/octet-stream",
    ]) {
      expect({ inline, result: isActiveUserContentType(inline) }).toEqual({
        inline,
        result: false,
      });
    }
  });

  test("downloads active markup and leaves previewable types inline", () => {
    expect(userContentDispositionHeaders("text/html", "report.html")).toEqual({
      "Content-Disposition": 'attachment; filename="report.html"',
    });
    expect(userContentDispositionHeaders("image/svg+xml")).toEqual({
      "Content-Disposition": "attachment",
    });
    expect(
      userContentDispositionHeaders("text/html", "evil\"; filename*=UTF-8''x.html\r\nX: y"),
    ).toEqual({
      "Content-Disposition": 'attachment; filename="evil_ filename_UTF-8_x.html_X_ y"',
    });
    for (const inline of ["video/mp4", "audio/ogg"]) {
      expect(userContentDispositionHeaders(inline, "file.bin")).toEqual({});
    }
    for (const inline of ["image/png", "application/pdf", "text/plain"]) {
      expect(userContentDispositionHeaders(inline, "file.bin")).toEqual({});
      expect(userContentResponseHeaders(inline, "file.bin")).toEqual({
        ...USER_CONTENT_SECURITY_HEADERS,
      });
    }
    expect(userContentResponseHeaders("text/html", "page.html")).toEqual({
      ...USER_CONTENT_SECURITY_HEADERS,
      "Content-Disposition": 'attachment; filename="page.html"',
    });
  });

  test("every API route that streams user-controlled bytes applies the shared headers", async () => {
    const read = (path: string) => readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
    const files = await read("routes/files.ts");
    const retained = files.slice(files.indexOf("async function serveRetainedArtifactContent"));
    expect(retained).toContain("userContentResponseHeaders(metadata.contentType");
    expect(retained).not.toContain('"X-Content-Type-Options": "nosniff"');
    for (const path of [
      "routes/editable-artifacts.ts",
      "routes/company-brain.ts",
      "routes/workspace-state.ts",
      "routes/computer-sessions.ts",
      "routes/browser-sessions.ts",
    ]) {
      expect({
        path,
        applied: (await read(path)).includes("USER_CONTENT_SECURITY_HEADERS"),
      }).toEqual({ path, applied: true });
    }
    const sites = await read("routes/workspace-artifacts.ts");
    const siteHtml = sites.slice(sites.indexOf("app.get(`${base}/:artifactId/html`"));
    expect(siteHtml.slice(0, siteHtml.indexOf("app.get(", 10))).toContain(
      '"Cross-Origin-Resource-Policy": "same-origin"',
    );
  });
});
