import { describe, expect, test } from "bun:test";
import path from "node:path";
import { OpenGeniClient } from "../src/artifact-client";
import { OpenGeniCoreClient } from "../src/core";
import { OpenGeniDocumentAuthorityClient } from "../src/document-authority";

const fixtureRoot = path.resolve(import.meta.dir, "fixtures");
const unusedOperatorMethodMarker = "UNUSED_OPERATOR_METHOD_SENTINEL";

async function bundle(entrypoint: string, injectUnusedOperatorMethod = false): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(fixtureRoot, entrypoint)],
    format: "esm",
    target: "browser",
    minify: true,
    plugins: injectUnusedOperatorMethod
      ? [
          {
            name: "inject-unused-operator-method",
            setup(build): void {
              build.onLoad({ filter: /document-authority-client\.ts$/ }, async (args) => {
                const source = await Bun.file(args.path).text();
                const classEnd = source.lastIndexOf("\n}");
                if (classEnd < 0) throw new Error("Could not find the operator client class end");
                return {
                  contents: `${source.slice(0, classEnd)}\n  async plantedUnusedOperatorMethod(): Promise<string> {\n    return "${unusedOperatorMethodMarker}";\n  }\n${source.slice(classEnd)}`,
                  loader: "ts",
                };
              });
            },
          },
        ]
      : [],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `Could not bundle ${entrypoint}`);
  }
  return await result.outputs[0]!.text();
}

describe("SDK browser bundle boundary", () => {
  test("preserves the document authority surface on existing client entries", () => {
    const clients = [
      new OpenGeniClient({ baseUrl: "https://api.example.test" }),
      new OpenGeniCoreClient({ baseUrl: "https://api.example.test" }),
      new OpenGeniDocumentAuthorityClient({ baseUrl: "https://api.example.test" }),
    ];

    for (const client of clients) {
      expect(client.reclassifyDocumentAuthority).toBeFunction();
      expect(client.listDocumentAuthorityReclassifications).toBeFunction();
      expect(client.runDocumentDefaultCollectionBackfill).toBeFunction();
      expect(client.listDocumentDefaultCollectionBackfillRuns).toBeFunction();
      expect(client.getDocumentDefaultCollectionBackfillAudit).toBeFunction();
      expect(client.listOrganizationDocumentAuthorityReclassifications).toBeFunction();
    }
  });

  test("keeps unused operator methods out of the browser client", async () => {
    const [core, coreWithUnusedOperatorMethod, documentAuthority, mutatedDocumentAuthority] =
      await Promise.all([
        bundle("core-bundle-entry.ts"),
        bundle("core-bundle-entry.ts", true),
        bundle("document-authority-bundle-entry.ts"),
        bundle("document-authority-bundle-entry.ts", true),
      ]);

    expect(core).toContain("/v1/workspaces/");
    expect(core).not.toContain("authority-reclassifications");
    expect(core).not.toContain("document-default-collection-backfills");
    expect(core).not.toContain("document-authority-reclassifications");

    expect(documentAuthority).toContain("authority-reclassifications");
    expect(documentAuthority).toContain("document-default-collection-backfills");
    expect(documentAuthority).toContain("document-authority-reclassifications");

    expect(coreWithUnusedOperatorMethod).toBe(core);
    expect(coreWithUnusedOperatorMethod).not.toContain(unusedOperatorMethodMarker);
    expect(mutatedDocumentAuthority).not.toBe(documentAuthority);
    expect(mutatedDocumentAuthority).toContain(unusedOperatorMethodMarker);
  });
});
