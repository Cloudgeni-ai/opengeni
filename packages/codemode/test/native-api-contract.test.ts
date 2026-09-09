import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "@opengeni/contracts";

test("native Codemode's compiled API acknowledgement matches the shared contract", () => {
  const source = readFileSync(
    new URL("../../../agent/crates/opengeni-agent/src/codemode.rs", import.meta.url),
    "utf8",
  );
  for (const [name, value] of [
    ["API_CONTRACT_HEADER", OPENGENI_API_CONTRACT_HEADER],
    ["API_CONTRACT_REVISION", OPENGENI_API_CONTRACT_REVISION],
  ]) {
    expect(source).toContain(`const ${name}: &str = "${value}";`);
  }
});
