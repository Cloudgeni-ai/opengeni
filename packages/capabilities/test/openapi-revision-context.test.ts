import { describe, expect, test } from "bun:test";

import { compileOpenApiRevision } from "../src";

const document = {
  openapi: "3.1.0",
  info: { title: "Revision context", version: "1" },
  servers: [{ url: "https://api.example.test/v1/" }],
  paths: {
    "/items": {
      get: { operationId: "listItems", responses: { "200": { description: "OK" } } },
    },
  },
};
const options = { definitionId: "revision-context" };

describe("OpenAPI immutable executable context", () => {
  test("a changed effective base URL changes the digest without changing tool identity", () => {
    const first = compileOpenApiRevision(document, options);
    const rotated = compileOpenApiRevision(document, {
      ...options,
      baseUrl: "https://rotated.example.test/v2/",
    });
    expect(rotated.bindings.listitems?.serverUrl).toBe("https://rotated.example.test/v2/");
    expect(rotated.id).not.toBe(first.id);
    expect(rotated.contentSha256).not.toBe(first.contentSha256);
    expect(rotated.tools).toEqual(first.tools);
    expect(first.bindings.listitems?.serverUrl).toBe("https://api.example.test/v1/");
  });

  test("normalized equivalent URLs and identical documents deduplicate", () => {
    const first = compileOpenApiRevision(document, options);
    for (const baseUrl of [
      "https://api.example.test/v1/",
      "https://API.EXAMPLE.TEST:443/other/../v1/",
    ]) {
      const same = compileOpenApiRevision(structuredClone(document), { ...options, baseUrl });
      expect(same.bindings).toEqual(first.bindings);
      expect(same.contentSha256).toBe(first.contentSha256);
      expect(same.id).toBe(first.id);
    }
  });

  test("relative document servers bind the resolved source context", () => {
    const relative = { ...document, servers: [{ url: "./v1/" }] };
    const first = compileOpenApiRevision(relative, {
      ...options,
      sourceUrl: "https://api.example.test/a/openapi.json",
    });
    const rotated = compileOpenApiRevision(relative, {
      ...options,
      sourceUrl: "https://api.example.test/b/openapi.json",
    });
    expect(rotated.bindings.listitems?.serverUrl).toBe("https://api.example.test/b/v1/");
    expect(rotated.id).not.toBe(first.id);
    expect(
      compileOpenApiRevision(relative, {
        ...options,
        sourceUrl: "https://api.example.test/a/another.json",
      }).id,
    ).toBe(first.id);
  });

  test("source-origin fallback is part of the executable identity", () => {
    const noServers = { ...document, servers: [] };
    const first = compileOpenApiRevision(noServers, {
      ...options,
      sourceUrl: "https://api.example.test/openapi.json",
    });
    const rotated = compileOpenApiRevision(noServers, {
      ...options,
      sourceUrl: "https://rotated.example.test/openapi.json",
    });
    expect(first.bindings.listitems?.serverUrl).toBe("https://api.example.test/");
    expect(rotated.id).not.toBe(first.id);
  });

  test("only effective URLs matter when operation and path servers override the base", () => {
    const scoped = {
      ...document,
      paths: {
        "/items": {
          servers: [{ url: "https://path.example.test/" }],
          get: document.paths["/items"].get,
          post: {
            operationId: "createItem",
            servers: [{ url: "https://operation.example.test/" }],
            responses: { "201": { description: "Created" } },
          },
        },
      },
    };
    const first = compileOpenApiRevision(scoped, options);
    const ignored = compileOpenApiRevision(scoped, {
      ...options,
      baseUrl: "https://ignored.example.test/",
    });
    expect(first.bindings.listitems?.serverUrl).toBe("https://path.example.test/");
    expect(first.bindings.createitem?.serverUrl).toBe("https://operation.example.test/");
    expect(ignored.bindings).toEqual(first.bindings);
    expect(ignored.id).toBe(first.id);
  });

  test("provider schema mode remains identity-bearing", () => {
    const ordinary = compileOpenApiRevision(document, options);
    const providerValidated = compileOpenApiRevision(document, {
      ...options,
      schemaMode: "provider_validated_json",
    });
    expect(providerValidated.id).not.toBe(ordinary.id);
    expect(
      compileOpenApiRevision(document, {
        ...options,
        schemaMode: "provider_validated_json",
        baseUrl: "https://API.EXAMPLE.TEST:443/v1/",
      }).id,
    ).toBe(providerValidated.id);
  });

  test("a changed primary operation server cannot reuse the immutable manifest identity", () => {
    const path = (operationId: string, serverUrl: string) => ({
      get: {
        operationId,
        servers: [{ url: serverUrl }],
        responses: { "200": { description: "OK" } },
      },
    });
    const firstPath = path("first", "https://first.example.test/");
    const secondPath = path("second", "https://second.example.test/");
    const first = compileOpenApiRevision(
      { ...document, paths: { "/first": firstPath, "/second": secondPath } },
      options,
    );
    const reordered = compileOpenApiRevision(
      { ...document, paths: { "/second": secondPath, "/first": firstPath } },
      options,
    );
    expect(Object.values(first.bindings)[0]?.serverUrl).toBe("https://first.example.test/");
    expect(Object.values(reordered.bindings)[0]?.serverUrl).toBe("https://second.example.test/");
    expect(reordered.id).not.toBe(first.id);
  });

  test("numeric operation IDs retain the manifest primary URL and revision across path reorders", () => {
    const path = (operationId: string, serverUrl: string) => ({
      get: {
        operationId,
        servers: [{ url: serverUrl }],
        responses: { "200": { description: "OK" } },
      },
    });
    const one = path("1", "https://one.example.test/");
    const two = path("2", "https://two.example.test/");
    const firstDocument = { ...document, paths: { "/two": two, "/one": one } };
    const reorderedDocument = { ...document, paths: { "/one": one, "/two": two } };
    expect(reorderedDocument).toEqual(firstDocument);
    const first = compileOpenApiRevision(firstDocument, options);
    const reordered = compileOpenApiRevision(reorderedDocument, options);
    expect(first.tools.map((tool) => tool.id)).toEqual(["2", "1"]);
    expect(reordered.tools.map((tool) => tool.id)).toEqual(["1", "2"]);
    expect(reordered.bindings).toEqual(first.bindings);
    const byId = (revision: typeof first) =>
      [...revision.tools].sort((left, right) => left.id.localeCompare(right.id));
    expect(byId(reordered)).toEqual(byId(first));
    // Integer-like binding keys enumerate numerically, not by path insertion.
    expect(Object.keys(first.bindings)).toEqual(["1", "2"]);
    expect(Object.values(first.bindings)[0]?.serverUrl).toBe("https://one.example.test/");
    expect(Object.values(reordered.bindings)[0]?.serverUrl).toBe("https://one.example.test/");
    expect(reordered.contentSha256).toBe(first.contentSha256);
    expect(reordered.id).toBe(first.id);
  });

  test("invalid executable URLs are still rejected before a revision is returned", () => {
    for (const baseUrl of [
      "https://user:secret@api.example.test/",
      "https://api.example.test/#fragment",
      "file:///workspace/data",
    ]) {
      expect(() => compileOpenApiRevision(document, { ...options, baseUrl })).toThrow();
    }
  });
});
