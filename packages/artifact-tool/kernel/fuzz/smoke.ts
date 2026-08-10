const targets = [
  "snapshot_decode",
  "collaboration_snapshot_decode",
  "operation_sequences",
  "collaboration_sequences",
  "binding_protocol_decode",
] as const;

const fuzzRoot = new URL("./", import.meta.url).pathname;
const manifest = `${fuzzRoot}Cargo.toml`;

for (const target of targets) {
  const process = Bun.spawn(
    [
      "cargo",
      "run",
      "--quiet",
      "--manifest-path",
      manifest,
      "--bin",
      target,
      "--",
      "-runs=256",
      "-timeout=3",
      "-max_len=4096",
      `${fuzzRoot}corpus/${target}`,
    ],
    { cwd: fuzzRoot, stdout: "inherit", stderr: "inherit" },
  );
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`libFuzzer corpus smoke failed for ${target} (exit ${exitCode})`);
  }
}
