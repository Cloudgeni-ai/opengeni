/** Explicit parity with the host OGB1 codec; this does not dispatch requests. */
import { join } from "node:path";
import {
  NativeBrokerFrameDecoder,
  encodeNativeBrokerFrame,
  type NativeBrokerFrame,
} from "../../../../packages/runtime/src/sandbox/providers/native-command-broker-wire";

const build = process.argv[2];
if (!build?.startsWith("/")) throw new Error("Expected absolute native build directory");
const brokerId = "11111111-1111-4111-8111-111111111111";
let cases = 0;
function compare(input: Uint8Array) {
  let valid = false;
  try {
    const decoder = new NativeBrokerFrameDecoder(brokerId);
    const frames = decoder.push(input);
    decoder.finish();
    valid = frames.length === 1 && frames[0]!.direction === "request" &&
      Buffer.from(encodeNativeBrokerFrame(frames[0]!)).equals(input);
  } catch {
    // The native one-frame request parser must reject the same closed input.
  }
  const result = Bun.spawnSync([join(build!, "broker-wire"), brokerId], {
    stdin: input, stdout: "pipe", stderr: "pipe", timeout: 3000,
  });
  cases += 1;
  if (result.exitCode !== (valid ? 0 : 125) || result.stderr.length ||
      (valid ? !Buffer.from(result.stdout).equals(input) : result.stdout.length !== 0)) {
    throw new Error(`Native wire parity failed at fixture ${cases}; exit ${result.exitCode}`);
  }
}

const base: NativeBrokerFrame = {
  direction: "request", brokerId, ownerEpoch: 1, sequence: 1,
  requestId: "22222222-2222-4222-8222-222222222222",
  commandId: "33333333-3333-4333-8333-333333333333", kind: "stdin", offset: 0,
  payload: new Uint8Array([0, 255, 128, 13, 10, 9]),
};
for (const frame of [base, { ...base, payload: new Uint8Array() },
  { ...base, payload: new Uint8Array(8192).fill(255) },
  { ...base, ownerEpoch: Number.MAX_SAFE_INTEGER, sequence: Number.MAX_SAFE_INTEGER },
  { ...base, commandId: null, kind: "fence" as const, payload: new Uint8Array() }]) {
  compare(encodeNativeBrokerFrame(frame));
}
const bytes = encodeNativeBrokerFrame(base);
for (let offset = 0; offset < bytes.length; offset++) {
  compare(bytes.subarray(0, offset));
  for (const mask of [1, 128, 255]) {
    const mutated = Uint8Array.from(bytes);
    mutated[offset] = mutated[offset]! ^ mask;
    compare(mutated);
  }
}
for (const suffix of [Buffer.from([0]), bytes]) compare(Buffer.concat([bytes, suffix]));
console.log(JSON.stringify({ kind: "native-command-wire-parity", cases, mismatches: 0,
  providerQualification: false, commandAdmission: false }));
