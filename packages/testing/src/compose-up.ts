export {};

const [projectName, composeFile, encodedImages] = Bun.argv.slice(2);

if (!projectName || !composeFile || !encodedImages) {
  console.error("compose-up requires a project name, compose file, and encoded service image map");
  process.exit(64);
}

let images: unknown;
try {
  images = JSON.parse(encodedImages);
} catch (error) {
  console.error(`compose-up received an invalid service image map: ${String(error)}`);
  process.exit(64);
}
if (!isServiceImageMap(images)) {
  console.error("compose-up service image map must contain safe service names and image strings");
  process.exit(64);
}

const pinnedImageEntries: Array<{ service: string; image: string; imageId: string }> = [];
for (const [index, [service, image]] of Object.entries(images).entries()) {
  pinnedImageEntries.push({
    service,
    image,
    imageId: await pinPulledImage(image, index),
  });
}
for (const { image, imageId } of pinnedImageEntries) {
  const availabilityFailure = await ensurePinnedImageAvailable(image, imageId);
  if (availabilityFailure) {
    console.error(availabilityFailure);
    process.exit(1);
  }
}
const pinnedImages = Object.fromEntries(
  pinnedImageEntries.map(({ service, imageId }) => [service, { image: imageId }]),
);
const imageOverrideFile = `${composeFile}.images.json`;
await Bun.write(imageOverrideFile, JSON.stringify({ services: pinnedImages }));
run([
  "docker",
  "compose",
  "-p",
  projectName,
  "-f",
  composeFile,
  "-f",
  imageOverrideFile,
  "up",
  "-d",
  "--pull",
  "never",
]);

function isServiceImageMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length > 0 &&
    entries.every(
      ([service, image]) =>
        /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(service) &&
        service !== "__proto__" &&
        typeof image === "string" &&
        image.length > 0 &&
        image === image.trim(),
    )
  );
}

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

async function pinPulledImage(image: string, index: number): Promise<string> {
  // A RUNNING sleeper makes the image in-use across both image cleanup and
  // `docker system prune`: a stopped pin is unsafe because system prune removes
  // stopped containers first and can then reap their images before Compose has
  // created the real service containers. The pin exposes no ports and bypasses
  // the image's service entrypoint. stopTestServices removes it with `rm -f -v`.
  const pinName = `${projectName}-image-pin-${index}`;
  let lastFailure = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    Bun.spawnSync(["docker", "rm", "-f", "-v", pinName], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const localImage = inspectImageId(image);
    if (!localImage.imageId) {
      if (!isRetryablePinRace(localImage.failure)) {
        lastFailure = `failed to inspect local image ${image}: ${localImage.failure}`;
        break;
      }
      const pullFailure = await pullImage(image);
      if (pullFailure) {
        lastFailure = pullFailure;
        break;
      }
    }
    const created = Bun.spawnSync(
      [
        "docker",
        "create",
        "--name",
        pinName,
        "--label",
        `com.opengeni.test-image-pin=${projectName}`,
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        "while :; do sleep 3600; done",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    if (created.exitCode === 0) {
      const started = Bun.spawnSync(["docker", "start", pinName], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      if (started.exitCode === 0) {
        const inspected = Bun.spawnSync(
          ["docker", "inspect", "--format", "{{.Image}} {{.State.Running}}", pinName],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        );
        if (inspected.exitCode === 0) {
          const output = new TextDecoder().decode(inspected.stdout).trim();
          const match = /^(sha256:[0-9a-f]{64}) true$/.exec(output);
          if (match) {
            const imageId = match[1];
            if (imageId) {
              const availabilityFailure = await ensurePinnedImageAvailable(image, imageId);
              if (!availabilityFailure) {
                return imageId;
              }
              lastFailure = availabilityFailure;
            }
          }
          if (!match) {
            lastFailure = `pin inspection returned an invalid image/running state: ${JSON.stringify(output)}`;
          }
        } else {
          lastFailure = new TextDecoder().decode(inspected.stderr);
        }
      } else {
        lastFailure = new TextDecoder().decode(started.stderr);
      }
    } else {
      lastFailure = new TextDecoder().decode(created.stderr);
    }

    Bun.spawnSync(["docker", "rm", "-f", "-v", pinName], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    if (!isRetryablePinRace(lastFailure) || attempt === 3) {
      break;
    }
    console.error(
      `image ${image} or its pin was reaped before the running pin settled; retrying (${attempt}/3)`,
    );
  }
  console.error(`failed to pin image ${image} with ${pinName}: ${lastFailure}`);
  process.exit(1);
}

async function ensurePinnedImageAvailable(image: string, imageId: string): Promise<string | null> {
  const inspected = inspectImageId(imageId);
  if (inspected.imageId === imageId) return null;
  if (!isRetryablePinRace(inspected.failure)) {
    return `failed to inspect pinned image ${imageId}: ${inspected.failure}`;
  }

  // A prune request can select an image immediately before the running pin is
  // created, then commit that deletion after the pin starts. The container's
  // rootfs survives, but Docker can no longer create another container from its
  // image ID. Re-pulling while the pin is already running restores the same
  // image metadata; every later prune observes the running owner and skips it.
  console.error(`pinned image ${imageId} was deleted by an in-flight prune; restoring ${image}`);
  const pullFailure = await pullImage(image);
  if (pullFailure) return pullFailure;
  const restored = inspectImageId(image);
  if (restored.imageId !== imageId) {
    return `restoring ${image} did not recover pinned image ${imageId}: ${restored.failure || `resolved ${restored.imageId ?? "no image ID"}`}`;
  }
  return null;
}

async function pullImage(image: string): Promise<string | null> {
  let lastFailure = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = Bun.spawnSync(["docker", "pull", image], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(result.stderr).trim();
    if (stderr) console.error(stderr);
    if (result.exitCode === 0) return null;
    lastFailure = stderr || `docker pull exited ${result.exitCode}`;
    if (!isRetryablePullError(lastFailure) || attempt === 3) break;
    console.error(`transient pull failure for ${image}; retrying (${attempt}/3)`);
    await Bun.sleep(250 * attempt);
  }
  return `failed to pull required image ${image}: ${lastFailure}`;
}

function isRetryablePullError(message: string): boolean {
  return [
    "Client.Timeout exceeded",
    "TLS handshake timeout",
    "connection reset by peer",
    "connection refused",
    "i/o timeout",
    "temporary failure",
    "unexpected EOF",
    "context deadline exceeded",
    "connection timed out",
    "network is unreachable",
    "no such host",
    "bad gateway",
    "gateway timeout",
    "internal server error",
    "service unavailable",
    "too many requests",
    "toomanyrequests",
  ].some((part) => message.toLowerCase().includes(part.toLowerCase()));
}

function inspectImageId(reference: string): { imageId?: string; failure: string } {
  const result = Bun.spawnSync(["docker", "image", "inspect", "--format", "{{.Id}}", reference], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0) {
    return { failure: stderr || `docker image inspect exited ${result.exitCode}` };
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(stdout)) {
    return { failure: `docker image inspect returned invalid ID ${JSON.stringify(stdout)}` };
  }
  return { imageId: stdout, failure: "" };
}

function isRetryablePinRace(message: string): boolean {
  return ["No such image", "No such container", "No such object"].some((part) =>
    message.includes(part),
  );
}
