import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import {
  USER_CONTENT_SECURITY_HEADERS,
  USER_CONTENT_SECURITY_POLICY,
  USER_MEDIA_CONTENT_SECURITY_POLICY,
  isActiveUserContentType,
  isPlayableMediaUserContentType,
  userContentDispositionHeaders,
  userContentResponseHeaders,
  userContentSecurityPolicy,
  userContentSignedGetUrlOptions,
} from "../src/http/user-content";

/**
 * Every API route response that carries a non-empty body built outside JSON
 * helpers, per route file. A new one fails this test until it is classified:
 * stored or user-controlled bytes must use the user-content headers; anything
 * else needs a reason here.
 */
const RAW_BODY_RESPONSES: Record<string, { count: number; userContent: boolean; why: string }> = {
  "browser-sessions.ts": { count: 1, userContent: true, why: "live browser frame" },
  "catalog-assets.ts": {
    count: 1,
    userContent: false,
    why: "operator-curated catalog asset; already sandboxed and embeddable by hosts",
  },
  "company-brain.ts": { count: 1, userContent: true, why: "Company Brain export" },
  "computer-sessions.ts": { count: 1, userContent: true, why: "live computer frame" },
  "editable-artifacts.ts": { count: 1, userContent: true, why: "materialized export download" },
  "files.ts": { count: 1, userContent: true, why: "retained file and screenshot content" },
  "install.ts": { count: 2, userContent: false, why: "operator-built install script and assets" },
  "managed-auth-session-sets.ts": {
    count: 1,
    userContent: false,
    why: "authentication provider response passthrough",
  },
  "personal-github-git-broker.ts": {
    count: 2,
    userContent: false,
    why: "git smart-HTTP passthrough and plain-text broker errors",
  },
  "workspace-artifacts.ts": { count: 1, userContent: true, why: "Site HTML (opaque origin)" },
  "workspace-state.ts": { count: 1, userContent: true, why: "workspace state export" },
};

/**
 * Signed object-storage GET URLs minted by the API, per file, and how many of
 * them pass `userContentSignedGetUrlOptions`. The others are fetched by a
 * machine or point at a type that is never active markup.
 */
const SIGNED_GET_URLS: Record<string, { calls: number; withUserContentOptions: number }> = {
  "mcp/files.ts": { calls: 1, withUserContentOptions: 1 },
  // Browser-controller upload/download authorities and encrypted profile archives.
  "routes/browser-sessions.ts": { calls: 3, withUserContentOptions: 0 },
  "routes/documents.ts": { calls: 1, withUserContentOptions: 1 },
  "routes/files.ts": { calls: 2, withUserContentOptions: 2 },
  "routes/knowledge.ts": { calls: 1, withUserContentOptions: 1 },
  // Capture manifests and file bodies are stored as JSON/octet-stream and fetched by the client.
  "routes/workspace-capture.ts": { calls: 2, withUserContentOptions: 0 },
  // Site HTML downloads; the JSON source bundle is never active markup.
  "site-uploads.ts": { calls: 2, withUserContentOptions: 1 },
};

async function sourceFiles(directory: URL, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(
        ...(await sourceFiles(new URL(`${entry.name}/`, directory), `${prefix}${entry.name}/`)),
      );
    } else if (entry.name.endsWith(".ts")) {
      files.push(`${prefix}${entry.name}`);
    }
  }
  return files.sort();
}

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
    const injected = userContentDispositionHeaders(
      "text/html",
      "evil\"; filename*=UTF-8''x.html\r\nX: y",
    )["Content-Disposition"];
    expect(injected).toBe(
      'attachment; filename="evil_ filename_UTF-8_x.html_X_ y"; ' +
        "filename*=UTF-8''evil%22%3B%20filename%2A%3DUTF-8%27%27x.html_X%3A%20y",
    );
    // Neither parameter can break out of the header or add another one.
    expect(injected).not.toMatch(/[\r\n]/);
    expect(injected!.split(";").map((part) => part.trim().split("=")[0])).toEqual([
      "attachment",
      "filename",
      "filename*",
    ]);
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

  test("keeps a non-ASCII filename through an RFC 6266 filename* parameter", () => {
    expect(userContentDispositionHeaders("text/html", "报告 (final).html")).toEqual({
      "Content-Disposition":
        'attachment; filename="_ _final_.html"; ' +
        "filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%28final%29.html",
    });
    expect(userContentDispositionHeaders("image/svg+xml", "Ærlig/../svg\u0000.svg")).toEqual({
      "Content-Disposition":
        "attachment; filename=\"_rlig_.._svg_.svg\"; filename*=UTF-8''%C3%86rlig_.._svg_.svg",
    });
    // A lone surrogate cannot be UTF-8 encoded, so it never reaches filename*.
    expect(userContentDispositionHeaders("text/html", "a\ud800b.html")).toEqual({
      "Content-Disposition": 'attachment; filename="a_b.html"',
    });
    expect(userContentDispositionHeaders("text/html", " \u0000 ")).toEqual({
      "Content-Disposition": 'attachment; filename="_"',
    });
  });

  test("signs object-storage URLs for active markup as attachments only", () => {
    expect(userContentSignedGetUrlOptions("text/html; charset=utf-8", "report.html")).toEqual({
      responseContentDisposition: 'attachment; filename="report.html"',
    });
    expect(userContentSignedGetUrlOptions("image/svg+xml")).toEqual({
      responseContentDisposition: "attachment",
    });
    for (const inline of ["image/png", "application/pdf", "video/mp4", "text/plain"]) {
      expect(userContentSignedGetUrlOptions(inline, "file.bin")).toEqual({});
    }
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
    const siteHtmlRoute = siteHtml.slice(0, siteHtml.indexOf("app.get(", 10));
    expect(siteHtmlRoute).toContain('"Cross-Origin-Resource-Policy": "same-origin"');
    expect(siteHtmlRoute).toContain('userContentDispositionHeaders("text/html"');
  });

  test("every raw route response body is classified, and user content uses the helper", async () => {
    const routes = new URL("../src/routes/", import.meta.url);
    const nonEmptyBody = /new Response\(\s*(?!null\b)|\b(?:c|context|ctx)\.body\(\s*(?!null\b)/g;
    const found: Record<string, number> = {};
    for (const path of await sourceFiles(routes)) {
      const count = [...(await readFile(new URL(path, routes), "utf8")).matchAll(nonEmptyBody)]
        .length;
      if (count > 0) found[path] = count;
    }
    expect(found).toEqual(
      Object.fromEntries(
        Object.entries(RAW_BODY_RESPONSES).map(([path, entry]) => [path, entry.count]),
      ),
    );
    for (const [path, entry] of Object.entries(RAW_BODY_RESPONSES)) {
      const source = await readFile(new URL(path, routes), "utf8");
      expect({ path, why: entry.why, usesHelper: source.includes("../http/user-content") }).toEqual(
        { path, why: entry.why, usesHelper: entry.userContent },
      );
    }
  });

  test("every browser-facing signed GET URL for stored content passes the attachment options", async () => {
    const src = new URL("../src/", import.meta.url);
    const found: Record<string, { calls: number; withUserContentOptions: number }> = {};
    for (const path of await sourceFiles(src)) {
      if (path === "http/user-content.ts") continue;
      const source = await readFile(new URL(path, src), "utf8");
      const calls = source.match(/\.createGetUrl\(/g)?.length ?? 0;
      if (calls === 0) continue;
      found[path] = {
        calls,
        withUserContentOptions: source.match(/userContentSignedGetUrlOptions\(/g)?.length ?? 0,
      };
    }
    expect(found).toEqual(SIGNED_GET_URLS);
  });
});
