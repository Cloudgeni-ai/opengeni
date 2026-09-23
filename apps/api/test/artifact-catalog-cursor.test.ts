import { expect, test } from "bun:test";
import { artifactCatalogCursorCodec } from "../src/artifact-catalog-cursor";

test("catalog cursors are opaque, authenticated and scoped to the complete request authority", () => {
  const value = {
    version: 1 as const,
    snapshotAt: new Date().toISOString(),
    expiresAt: Date.now() + 60_000,
    after: { kind: "site" as const, id: "private-native-id", key: "private title" },
  };
  const codec = artifactCatalogCursorCodec("secret", "principal:workspace:filters");
  const token = codec.encode(value);
  expect(codec.decode(token)).toEqual(value);
  expect(Buffer.from(token, "base64url").toString()).not.toContain("private");
  expect(codec.encode(value)).not.toBe(token);
  expect(() => artifactCatalogCursorCodec("secret", "another-principal").decode(token)).toThrow(
    "Invalid or expired",
  );
  expect(() =>
    artifactCatalogCursorCodec("other-secret", "principal:workspace:filters").decode(token),
  ).toThrow("Invalid or expired");
  const tampered = Buffer.from(token, "base64url");
  tampered[30] = tampered[30]! ^ 1;
  expect(() => codec.decode(tampered.toString("base64url"))).toThrow("Invalid or expired");
  for (const invalid of ["", "not a cursor", token + "=", "x".repeat(8193)])
    expect(() => codec.decode(invalid)).toThrow();
  expect(() => codec.decode(codec.encode({ ...value, expiresAt: Date.now() - 1 }))).toThrow(
    "Invalid or expired",
  );
});
