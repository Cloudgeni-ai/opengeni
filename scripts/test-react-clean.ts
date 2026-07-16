const child = Bun.spawn({
  cmd: [process.execPath, "test", "packages/react"],
  cwd: process.cwd(),
  env: process.env,
  stdout: "pipe",
  stderr: "pipe",
});

const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);

process.stdout.write(stdout);
process.stderr.write(stderr);

if (exitCode !== 0) {
  process.exit(exitCode);
}

const warningLines = `${stdout}\n${stderr}`
  .split(/\r?\n/u)
  .filter(
    (line) =>
      /^An update to .* was not wrapped in act/u.test(line) ||
      /^The current testing environment is not configured to support act/u.test(line) ||
      /^(?:\[[^\]]+\]\s*)?Warning:/u.test(line) ||
      /^warning:/iu.test(line),
  );

if (warningLines.length > 0) {
  console.error("React tests emitted runtime warnings:");
  for (const line of warningLines) {
    console.error(`- ${line}`);
  }
  process.exit(1);
}
