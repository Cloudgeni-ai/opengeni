#!/usr/bin/env bun
/**
 * The Microsoft 365 built-ins compile their tools from one pinned Microsoft
 * Graph OpenAPI document (MICROSOFT_GRAPH_OPENAPI_PIN), never from the moving
 * upstream branch. This script checks the pin and shows what moving it would
 * change, definition by definition, before anyone edits it.
 *
 *   bun scripts/graph-openapi-pin.ts                 check the pin: digest, and every reviewed operation exists
 *   bun scripts/graph-openapi-pin.ts --diff <commit>  compare the pin with msgraph-metadata at <commit> (or a URL)
 *
 * --diff prints the reviewed operations the candidate lacks (tools that would
 * disappear), the operations entering or leaving each generic path scope, and
 * the pin to paste when the candidate is acceptable.
 */
import { createHash } from "node:crypto";

import {
  CORE_INTEGRATION_DEFINITIONS,
  MAX_CURATED_INTEGRATION_SPEC_BYTES,
  MICROSOFT_GRAPH_OPENAPI_PIN,
  genericPathScopeOperations,
  parseOpenApiDocument,
  type IntegrationDefinition,
} from "../packages/capabilities/src";

const METADATA_RAW = "https://raw.githubusercontent.com/microsoftgraph/msgraph-metadata";
const DOCUMENT_PATH = "openapi/v1.0/openapi.yaml";

export type PinDefinitionDiff = {
  definitionId: string;
  /** Reviewed operations (`METHOD path`) the candidate document lacks. */
  missingReviewed: string[];
  /** Generic path scope operations only the candidate has. */
  scopeAdded: string[];
  /** Generic path scope operations only the current document has. */
  scopeRemoved: string[];
};

const graphDefinitions = (): IntegrationDefinition[] =>
  CORE_INTEGRATION_DEFINITIONS.filter(
    (definition) =>
      definition.source.kind === "openapi" &&
      definition.source.pinned?.url === MICROSOFT_GRAPH_OPENAPI_PIN.url,
  );

/** Reviewed operations (`METHOD path`) a document doesn't define. */
export function missingReviewedOperations(
  document: Record<string, unknown>,
  definition: IntegrationDefinition,
): string[] {
  if (definition.source.kind !== "openapi") return [];
  const paths = (document.paths ?? {}) as Record<string, Record<string, unknown> | undefined>;
  return (definition.source.operationAllowlist ?? [])
    .filter((entry) => !paths[entry.path]?.[entry.method])
    .map((entry) => `${entry.method.toUpperCase()} ${entry.path}`);
}

/** What moving a definition from one document to another changes. */
export function pinDefinitionDiff(
  current: Record<string, unknown>,
  candidate: Record<string, unknown>,
  definition: IntegrationDefinition,
): PinDefinitionDiff {
  const scope = (document: Record<string, unknown>) =>
    new Set(
      genericPathScopeOperations(document, definition).map(
        (operation) => `${operation.method.toUpperCase()} ${operation.path}`,
      ),
    );
  const before = scope(current);
  const after = scope(candidate);
  return {
    definitionId: definition.id,
    missingReviewed: missingReviewedOperations(candidate, definition),
    scopeAdded: [...after].filter((operation) => !before.has(operation)).sort(),
    scopeRemoved: [...before].filter((operation) => !after.has(operation)).sort(),
  };
}

async function download(url: string): Promise<{ bytes: Uint8Array; sha256: string }> {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const parse = (bytes: Uint8Array) =>
  parseOpenApiDocument(bytes, { maxBytes: MAX_CURATED_INTEGRATION_SPEC_BYTES });

async function main(argv: readonly string[]): Promise<number> {
  const pinned = await download(MICROSOFT_GRAPH_OPENAPI_PIN.url);
  if (pinned.sha256 !== MICROSOFT_GRAPH_OPENAPI_PIN.sha256) {
    console.error(
      `The pinned document's digest is ${pinned.sha256}, not ${MICROSOFT_GRAPH_OPENAPI_PIN.sha256}.`,
    );
    return 1;
  }
  const current = parse(pinned.bytes);
  const diffAt = argv.indexOf("--diff");
  if (diffAt === -1) {
    let failed = false;
    for (const definition of graphDefinitions()) {
      const missing = missingReviewedOperations(current, definition);
      const scope = genericPathScopeOperations(current, definition).length;
      console.log(
        `${definition.id}: ${definition.source.kind === "openapi" ? (definition.source.operationAllowlist?.length ?? 0) : 0} reviewed operations, ${scope} in the generic path scope${missing.length ? `; missing: ${missing.join(", ")}` : ""}`,
      );
      failed ||= missing.length > 0;
    }
    return failed ? 1 : 0;
  }
  const target = argv[diffAt + 1];
  if (!target) {
    console.error("--diff needs a msgraph-metadata commit or a document URL");
    return 2;
  }
  const url = /^[0-9a-f]{40}$/.test(target) ? `${METADATA_RAW}/${target}/${DOCUMENT_PATH}` : target;
  const candidate = await download(url);
  const next = parse(candidate.bytes);
  let blocking = false;
  for (const definition of graphDefinitions()) {
    const diff = pinDefinitionDiff(current, next, definition);
    console.log(`\n## ${diff.definitionId}`);
    if (diff.missingReviewed.length > 0) {
      blocking = true;
      console.log(`Reviewed operations the candidate lacks (their tools would disappear):`);
      for (const operation of diff.missingReviewed) console.log(`  - ${operation}`);
    }
    for (const [label, operations] of [
      ["Generic path scope gains", diff.scopeAdded],
      ["Generic path scope loses", diff.scopeRemoved],
    ] as const) {
      if (operations.length === 0) continue;
      console.log(`${label} ${operations.length}:`);
      for (const operation of operations)
        console.log(`  ${label.endsWith("gains") ? "+" : "-"} ${operation}`);
    }
    if (!diff.missingReviewed.length && !diff.scopeAdded.length && !diff.scopeRemoved.length) {
      console.log("No operation changes.");
    }
  }
  console.log(`\nPin for the candidate:\n  url: "${url}",\n  sha256: "${candidate.sha256}",`);
  return blocking ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
