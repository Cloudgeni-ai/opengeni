import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const BLOCK_START = "# Agent Python toolchain";
const BLOCK_END = "rm -rf /root/.cache /var/cache/pip /var/cache/uv\n";
const PREINSTALLED = ["matplotlib", "numpy", "pandas", "pytest", "requests"];

async function readDockerfiles() {
  const [sandbox, desktop] = await Promise.all([
    readFile(resolve(root, "docker/sandbox.Dockerfile"), "utf8"),
    readFile(resolve(root, "docker/desktop.Dockerfile"), "utf8"),
  ]);
  return { sandbox, desktop };
}

function toolchainBlock(dockerfile: string): string {
  const start = dockerfile.indexOf(BLOCK_START);
  expect(start).toBeGreaterThan(-1);
  const end = dockerfile.indexOf(BLOCK_END, start);
  expect(end).toBeGreaterThan(start);
  return dockerfile.slice(start, end + BLOCK_END.length);
}

function argDefault(dockerfile: string, name: string): string {
  const matches = [...dockerfile.matchAll(new RegExp(`^ARG ${name}=(.+)$`, "gmu"))];
  expect(matches).toHaveLength(1);
  return matches[0]![1]!.replace(/^"|"$/gu, "");
}

describe("sandbox Python toolchain", () => {
  test("ships one identical, exactly pinned toolchain in both stock images", async () => {
    const { sandbox, desktop } = await readDockerfiles();
    expect(toolchainBlock(sandbox)).toBe(toolchainBlock(desktop));

    const uvVersion = argDefault(sandbox, "UV_VERSION");
    expect(uvVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(argDefault(desktop, "UV_VERSION")).toBe(uvVersion);

    const packages = argDefault(sandbox, "OPENGENI_PYTHON_PACKAGES");
    expect(argDefault(desktop, "OPENGENI_PYTHON_PACKAGES")).toBe(packages);
    const pins = packages.split(" ");
    for (const pin of pins) expect(pin).toMatch(/^[a-z][a-z0-9-]*==\d+(\.\d+)+$/u);
    expect(pins.map((pin) => pin.split("==")[0]).sort()).toEqual(PREINSTALLED);

    // The top-level pins do not fix the transitive closure (urllib3, pillow,
    // ...). One shared PyPI cutoff does, so both images resolve it identically.
    const excludeNewer = argDefault(sandbox, "OPENGENI_PYTHON_EXCLUDE_NEWER");
    expect(excludeNewer).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
    expect(argDefault(desktop, "OPENGENI_PYTHON_EXCLUDE_NEWER")).toBe(excludeNewer);
  });

  test("keeps pip and uv caches out of the snapshotted workspace", async () => {
    const block = toolchainBlock((await readDockerfiles()).desktop);
    expect(block).toContain('test "$(uv cache dir)" = /var/cache/uv');
    expect(block).toContain('test "$(python3 -m pip cache dir)" = /var/cache/pip');
  });

  test("gives the desktop image a python command like the headless image", async () => {
    const { desktop } = await readDockerfiles();
    expect(desktop).toMatch(/base_packages="[^"]*\bpython-is-python3\b[^"]*"/u);
  });

  test("lets a bare pip or uv install reach the system interpreter", async () => {
    const block = toolchainBlock((await readDockerfiles()).desktop);
    expect(block).toContain(
      "printf '[global]\\nbreak-system-packages = true\\nroot-user-action = ignore\\ncache-dir = /var/cache/pip\\n' > /etc/pip.conf",
    );
    expect(block).toContain(
      `printf 'cache-dir = "/var/cache/uv"\\n\\n[pip]\\nbreak-system-packages = true\\n' > /etc/uv/uv.toml`,
    );
    // No command-line override: the build install itself proves the global
    // configuration, exactly as an agent's bare `pip install` would hit it.
    expect(block).not.toContain("--break-system-packages");
    expect(block).not.toContain("PIP_BREAK_SYSTEM_PACKAGES");
    expect(block).toContain(
      "uv pip install --system --no-cache --compile-bytecode --only-binary :all: \\\n" +
        '      --exclude-newer "${OPENGENI_PYTHON_EXCLUDE_NEWER}" ${OPENGENI_PYTHON_PACKAGES};',
    );
    expect(block).toContain(
      "python3 -m pip install --no-cache-dir --no-index --dry-run ${OPENGENI_PYTHON_PACKAGES}",
    );
    expect(block).toContain(
      `python3 -c 'import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot, numpy, pandas, pytest, requests'`,
    );
  });

  test("verifies the pinned uv release for every supported architecture", async () => {
    const block = toolchainBlock((await readDockerfiles()).desktop);
    expect(block).toMatch(/amd64\) uv_arch="x86_64"; expected="[0-9a-f]{64}"/u);
    expect(block).toMatch(/arm64\|aarch64\) uv_arch="aarch64"; expected="[0-9a-f]{64}"/u);
    expect(block).toContain(
      '"https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${uv_dir}.tar.gz"',
    );
    expect(block).toContain('echo "$expected  $archive" | sha256sum -c -');
    expect(block).toContain('test "$(uv --version | cut -d\' \' -f2)" = "${UV_VERSION}"');
    expect(block).not.toContain("astral.sh/uv/install.sh");
  });

  test("stays in the source-invariant toolchain ahead of the exact artifact runtime", async () => {
    const { sandbox, desktop } = await readDockerfiles();
    for (const dockerfile of [sandbox, desktop]) {
      const finalStage = dockerfile.lastIndexOf("\nFROM ");
      const toolchain = dockerfile.indexOf(BLOCK_START);
      expect(toolchain).toBeGreaterThan(finalStage);
      expect(toolchain).toBeLessThan(
        dockerfile.indexOf("COPY --from=artifact-runtime-builder /opt/opengeni/artifact-runtime"),
      );
    }
  });
});
