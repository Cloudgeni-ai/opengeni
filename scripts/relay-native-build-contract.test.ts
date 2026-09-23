import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

function hasTargetSysroot(source: string): boolean {
  const start = source.indexOf("FROM --platform=$BUILDPLATFORM rust:1.82-alpine AS build");
  if (start < 0) return false;
  const end = source.indexOf("\nFROM ", start + 1);
  const stage = source.slice(start, end < 0 ? undefined : end);
  const target = stage.indexOf("ARG TARGETPLATFORM");
  const libraries = stage.indexOf("RUN xx-apk add --no-cache gcc musl-dev");
  const build = stage.indexOf("xx-cargo build --release");
  const verify = stage.indexOf('xx-verify "/build/target/${rust_target}/release/opengeni-relay"');
  return (
    stage.includes("COPY --from=xx / /") &&
    stage.includes("RUN apk add --no-cache clang lld") &&
    target >= 0 &&
    libraries > target &&
    build > libraries &&
    verify > build
  );
}

test("relay installs target C headers and runtime before native-speed musl cross compilation", async () => {
  const source = await readFile(
    resolve(import.meta.dir, "../agent/crates/opengeni-relay/Dockerfile"),
    "utf8",
  );
  expect(hasTargetSysroot(source)).toBe(true);
  expect(hasTargetSysroot(source.replace("RUN xx-apk add --no-cache gcc musl-dev", ""))).toBe(
    false,
  );
  expect(
    hasTargetSysroot(
      source.replace(
        "RUN xx-apk add --no-cache gcc musl-dev",
        "RUN apk add --no-cache gcc musl-dev",
      ),
    ),
  ).toBe(false);
  expect(hasTargetSysroot(source.replace("ARG TARGETPLATFORM", "ARG BUILDPLATFORM"))).toBe(false);
  expect(
    hasTargetSysroot(
      source.replace("FROM --platform=$BUILDPLATFORM rust:1.82-alpine", "FROM rust:1.82-alpine"),
    ),
  ).toBe(false);
  expect(
    hasTargetSysroot(
      source.replace('xx-verify "/build/target/${rust_target}/release/opengeni-relay"', "true"),
    ),
  ).toBe(false);
});
