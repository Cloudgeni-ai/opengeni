import { createHash } from "node:crypto";
import {
  ATTEMPT_TOOL_CATALOG_MAX_BYTES,
  ToolGatewayCatalog,
  type ToolGatewayCatalog as ToolGatewayCatalogValue,
} from "@opengeni/contracts";
import { ToolGatewayCatalogIntegrityError, ToolGatewayCatalogTooLargeError } from "./errors";

export function digestToolGatewayCatalog(catalog: Omit<ToolGatewayCatalogValue, "digest">): string {
  const { createdAt: _createdAt, ...authoritative } = catalog;
  return digestCanonicalJson(authoritative);
}

export function parseVerifiedToolGatewayCatalog(input: unknown): ToolGatewayCatalogValue {
  const catalog = ToolGatewayCatalog.parse(input);
  assertCatalogSize(catalog);
  const { digest, ...unsigned } = catalog;
  if (digestToolGatewayCatalog(unsigned) !== digest) {
    throw new ToolGatewayCatalogIntegrityError();
  }
  return catalog;
}

export function digestCanonicalJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(value)), "utf8")
    .digest("hex");
}

export function assertToolGatewayCatalogSize(catalog: ToolGatewayCatalogValue): void {
  assertCatalogSize(catalog);
}

function assertCatalogSize(catalog: ToolGatewayCatalogValue): void {
  if (
    new TextEncoder().encode(JSON.stringify(catalog)).byteLength > ATTEMPT_TOOL_CATALOG_MAX_BYTES
  ) {
    throw new ToolGatewayCatalogTooLargeError();
  }
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}
