// Delete only the recorded disposable experiment stack, never host-wide state.
import { resolve } from "node:path";
const state = resolve(import.meta.dir, ".state");
const stack = await Bun.file(`${state}/stack.json`).json();
if (
  !/^opengeni_test_[0-9a-f]{10}$/.test(stack.projectName) ||
  !stack.composeFile.startsWith(`${state}/tmp/`)
) {
  throw new Error("Refusing an unrecognized experiment stack");
}
async function command(args: string[]) {
  const process = Bun.spawn(args, { stdout: "pipe", stderr: "inherit" });
  const output = await new Response(process.stdout).text();
  if ((await process.exited) !== 0) throw new Error(`Cleanup failed: ${args[0]} ${args[1]}`);
  return output.trim();
}
const pins = await command([
  "docker",
  "ps",
  "-aq",
  "--filter",
  `label=com.opengeni.test-image-pin=${stack.projectName}`,
]);
if (pins) await command(["docker", "rm", "-f", "-v", ...pins.split("\n")]);
await command([
  "docker",
  "compose",
  "-p",
  stack.projectName,
  "-f",
  stack.composeFile,
  "down",
  "--volumes",
  "--remove-orphans",
]);
const remaining = await command([
  "docker",
  "ps",
  "-aq",
  "--filter",
  `label=com.docker.compose.project=${stack.projectName}`,
]);
if (remaining) throw new Error("Experiment containers remain");
console.log(JSON.stringify({ removedExperimentStack: stack.projectName }));
