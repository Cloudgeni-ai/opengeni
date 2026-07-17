const [projectName, composeFile, encodedImages] = Bun.argv.slice(2);

if (!projectName || !composeFile || !encodedImages) {
  console.error("compose-up requires a project name, compose file, and encoded image list");
  process.exit(64);
}

let images: unknown;
try {
  images = JSON.parse(encodedImages);
} catch (error) {
  console.error(`compose-up received an invalid image list: ${String(error)}`);
  process.exit(64);
}
if (!Array.isArray(images) || !images.every((image) => typeof image === "string")) {
  console.error("compose-up image list must contain only strings");
  process.exit(64);
}

for (const [index, image] of images.entries()) {
  pinPulledImage(image, index);
}
run(["docker", "compose", "-p", projectName, "-f", composeFile, "up", "-d", "--pull", "never"]);

function run(args: string[]): void {
  const result = Bun.spawnSync(args, {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

function pinPulledImage(image: string, index: number): void {
  // A stopped container makes the image in-use, so age-based host cleanup
  // cannot reap an old upstream digest between this pull and compose create.
  const pinName = `${projectName}-image-pin-${index}`;
  let lastFailure = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    run(["docker", "pull", image]);
    const result = Bun.spawnSync(
      [
        "docker",
        "create",
        "--name",
        pinName,
        "--label",
        `com.opengeni.test-image-pin=${projectName}`,
        image,
      ],
      { stdin: "ignore", stdout: "inherit", stderr: "pipe" },
    );
    if (result.exitCode === 0) {
      return;
    }

    lastFailure = new TextDecoder().decode(result.stderr);
    if (!lastFailure.includes("No such image")) {
      break;
    }
    console.error(`image ${image} was reaped before it could be pinned; retrying (${attempt}/3)`);
  }
  console.error(`failed to pin image ${image} with ${pinName}: ${lastFailure}`);
  process.exit(1);
}
