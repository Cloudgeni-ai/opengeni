export {};

const entry = process.argv[2];
if (!entry) {
  console.error("Expected an artifact boundary entrypoint");
  process.exit(2);
}

const result = await Bun.build({
  entrypoints: [entry],
  target: "browser",
  format: "esm",
  splitting: false,
  minify: false,
  external: ["@opengeni/*", "react", "react/*", "lucide-react"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const output of result.outputs) process.stdout.write(await output.text());