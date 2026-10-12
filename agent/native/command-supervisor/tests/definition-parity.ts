/** Explicit host/native parity target; needs Bun and the compiled C harness.
 * Definitions contain fixture data only; diagnostics never print body bytes.
 */
import { join } from "node:path";
import {
  decodeNativeBrokerCommandDefinition as decode,
  encodeNativeBrokerCommandDefinition as encode,
  type NativeBrokerCommandDefinition,
} from "../../../../packages/runtime/src/sandbox/providers/native-command-broker-definition";

const build = process.argv[2];
if (!build?.startsWith("/")) throw new Error("Expected absolute native build directory");
let cases = 0;
function compare(input: Uint8Array) {
  let valid = false;
  try {
    const parsed = decode(input);
    if (!Buffer.from(encode(parsed)).equals(input)) throw new Error("Noncanonical host round trip");
    valid = true;
  } catch {
    // Native refusal must match the host's closed definition contract.
  }
  const result = Bun.spawnSync([join(build!, "definition")], {
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 3000,
  });
  cases += 1;
  if (result.exitCode !== (valid ? 0 : 125) || result.stderr.length ||
      (valid ? !Buffer.from(result.stdout).equals(input) : result.stdout.length !== 0)) {
    throw new Error(`Native definition parity failed at fixture ${cases}; exit ${result.exitCode}`);
  }
}

const fixtures: NativeBrokerCommandDefinition[] = [
  { mode: "pipe", cwd: "/", argv: ["x"], env: [], rows: 0, columns: 0 },
  { mode: "pty", cwd: "/workspace/🦎", argv: ["/bin/sh", "-c", "printf '$LITERAL'", ""],
    env: [["LITERAL", "one\ntwo\t=🦎"], ["__proto__", "fixture"], ["EMPTY", ""]], rows: 24, columns: 80 },
  { mode: "pipe", cwd: "/", argv: ["a".repeat(131071), "b".repeat(131040)], env: [], rows: 0, columns: 0 },
  { mode: "pipe", cwd: "/", argv: Array(1024).fill("x"),
    env: Array.from({ length: 1024 }, (_, i) => [`KEY_${i}`, ""]), rows: 0, columns: 0 },
];
for (const fixture of fixtures) compare(encode(fixture));
for (const fixture of fixtures.slice(0, 2)) {
  const bytes = encode(fixture);
  for (let offset = 0; offset < bytes.length; offset++) {
    compare(bytes.subarray(0, offset));
    for (const mask of [1, 128, 255]) {
      const mutated = Uint8Array.from(bytes);
      mutated[offset] = mutated[offset]! ^ mask;
      compare(mutated);
    }
  }
  for (const suffix of [Buffer.from([0]), bytes]) compare(Buffer.concat([bytes, suffix]));
}
console.log(JSON.stringify({ kind: "native-command-definition-parity", cases, mismatches: 0,
  providerQualification: false, commandAdmission: false }));
