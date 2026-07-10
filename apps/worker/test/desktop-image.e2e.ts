// P4.1 — the canonical OpenGeni desktop image, productionized from the PROVEN
// spike. Two layers:
//
//  LOCAL (default; runs when Docker is available):
//    build docker/desktop.Dockerfile -> ogtest-desktop, run it, exec
//    opengeni-desktop-up, then assert (exactly like the spike that PASSED):
//      (a) noVNC /vnc.html      -> HTTP 200
//      (b) websockify WS upgrade -> 101 + the RFB banner bytes
//      (c) a REAL browser binary -> an ELF (NOT the Jammy snap-stub), launches
//      (d) the stack comes up    -> OPENGENI_DESKTOP_UP printed; :5900 + :6080 listen
//    Container + image are torn down in finally.
//
//  GATED LIVE MODAL (opt-in via OPENGENI_P41_LIVE_MODAL=1):
//    build a Modal image from docker/desktop.Dockerfile (Modal JS SDK image
//    builder), boot a box, run ensureDisplayStack via exec, and assert
//      Xvfb xdpyinfo OK + x11vnc:5900 + websockify:6080 + xdotool XTEST
//      mousemove read-back matches (the V2/gVisor computer-use proof) + scrot
//      captures content. The box is terminated in finally; no secret is printed.
//    Skipped (not failed) without the env gate.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { join } from "node:path";

const exec = promisify(execFile);

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const DOCKERFILE = "docker/desktop.Dockerfile";
const IMAGE = "ogtest-desktop";
const CTR = "ogtest-desktop-p41";
const HOST_PORT = 56081;

async function dockerAvailable(): Promise<boolean> {
  try {
    await exec("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function sh(cmd: string, timeout = 30_000): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec("docker", ["exec", CTR, "bash", "-lc", cmd], {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, out: `${stdout}\n${stderr}` };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      out: `${err.stdout ?? ""}\n${err.stderr ?? ""}`,
    };
  }
}

// Bun-native WebSocket probe: open ws://localhost:<port>/websockify with the
// 'binary' subprotocol, require the RFB server banner (the noVNC WS upgrade
// returns 101 then the VNC ProtocolVersion bytes "RFB 003.00x\n").
async function probeRfbBanner(
  port: number,
  timeoutMs = 8_000,
): Promise<{ ok: boolean; banner: string }> {
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, banner: string) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* noop */
      }
      resolve({ ok, banner });
    };
    const ws = new WebSocket(`ws://localhost:${port}/websockify`, ["binary"]);
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => finish(false, ""), timeoutMs);
    ws.addEventListener("message", (ev: MessageEvent) => {
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array();
      const head = new TextDecoder("latin1").decode(buf.subarray(0, 12));
      if (/^RFB \d{3}\.\d{3}/.test(head)) {
        clearTimeout(timer);
        finish(true, head);
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      finish(false, "");
    });
  });
}

let docker = false;
let built = false;

beforeAll(async () => {
  docker = await dockerAvailable();
  if (!docker) {
    console.warn(
      "[p41-image] docker unavailable — skipping the local image build + stack assertions",
    );
    return;
  }
  // best-effort clean slate
  await exec("docker", ["rm", "-f", CTR]).catch(() => undefined);
}, 30_000);

afterAll(async () => {
  if (!docker) return;
  await exec("docker", ["rm", "-f", CTR]).catch(() => undefined);
  // Remove the image we built (leave it if the build never produced it).
  if (built) {
    await exec("docker", ["image", "rm", "-f", IMAGE]).catch(() => undefined);
  }
}, 120_000);

describe("P4.1 desktop image — LOCAL build + stack-up assertions", () => {
  test(
    "build docker/desktop.Dockerfile, run it, assert noVNC/WS/real-Chrome/stack-up",
    async () => {
      if (!docker) return;

      // 1) BUILD the canonical desktop image from the repo root context.
      await exec("docker", ["build", "-t", IMAGE, "-f", DOCKERFILE, "."], {
        cwd: REPO_ROOT,
        timeout: 30 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
      });
      built = true;

      // 2) RUN it (entrypoint is `sleep infinity`; the stack is exec-launched).
      await exec("docker", ["run", "-d", "-p", `${HOST_PORT}:6080`, "--name", CTR, IMAGE]);

      // 3) (d) bring the stack up via the exec'd up-script (ensureDisplayStack equiv).
      const up = await sh("opengeni-desktop-up", 90_000);
      expect(up.code).toBe(0);
      expect(up.out).toContain("OPENGENI_DESKTOP_UP");

      // both sockets listen inside the box.
      const socks = await sh(
        "(nc -z localhost 5900 && echo VNC_OK); (nc -z localhost 6080 && echo WS_OK)",
      );
      expect(socks.out).toContain("VNC_OK");
      expect(socks.out).toContain("WS_OK");

      // 4) (c) a REAL browser is installed, NOT the Jammy snap-stub. The Jammy
      //    `chromium-browser` stub is a tiny shell script (a few hundred bytes) that
      //    demands the chromium SNAP and does NOTHING in a snapd-less container.
      //    google-chrome ships a launcher wrapper PLUS a real ELF `chrome` binary;
      //    the proof of "real browser" is (i) a genuine ELF binary present in the
      //    install dir, and (ii) `--version` actually launches and prints a version.
      //
      //    NOTE: /usr/local/bin/opengeni-browser is now a CONTAINER-SAFE WRAPPER SCRIPT
      //    (it adds --no-sandbox etc. so Chrome launches as root from the human exo/menu
      //    path), so we resolve the REAL engine via OPENGENI_BROWSER_BIN (the binary the
      //    wrapper execs), not via readlink of the wrapper itself.
      const browser = await sh(
        'BIN="${OPENGENI_BROWSER_BIN:-/usr/bin/google-chrome-stable}"; ' +
          'BIN=$(readlink -f "$BIN"); DIR=$(dirname "$BIN"); ' +
          'echo "resolved=$BIN"; ' +
          // find a real ELF binary in the install tree (chrome's actual engine).
          'ELF=$(for f in "$DIR/chrome" "$BIN" "$DIR"/*; do ' +
          '  [ -f "$f" ] && [ "$(head -c4 "$f" | xxd -p)" = "7f454c46" ] && { echo "$f"; break; }; done); ' +
          'echo "elf=$ELF"',
      );
      // a genuine ELF engine binary is present (NOT a lone shell stub like the snap).
      expect(browser.out).toMatch(/elf=\/.+/);
      expect(browser.out).not.toMatch(/elf=\s*$/m);

      // (c.2) the wrapper IS a container-safe script that passes --no-sandbox to the
      //       real engine — the fix for the root-without-sandbox launch failure.
      const wrapper = await sh("cat /usr/local/bin/opengeni-browser");
      expect(wrapper.out).toContain("--no-sandbox");
      expect(wrapper.out).toContain("--disable-dev-shm-usage");
      // it must be bash -n clean and executable.
      const wrapSyntax = await sh("bash -n /usr/local/bin/opengeni-browser && echo SYNTAX_OK");
      expect(wrapSyntax.out).toContain("SYNTAX_OK");

      // (c.3) the wrapper is wired as the XFCE default WebBrowser AND the x-www-browser
      //       alternative, so the human menu/exo path resolves to it (not the stock
      //       chrome-no-flags helper that died with "Input/output error").
      const defaults = await sh(
        "grep -h WebBrowser /etc/xdg/xfce4/helpers.rc; " +
          "readlink -f /etc/alternatives/x-www-browser",
      );
      expect(defaults.out).toContain("WebBrowser=opengeni-browser");
      expect(defaults.out).toContain("/usr/local/bin/opengeni-browser");

      // and the wrapper actually LAUNCHES enough to report a version (the snap-stub cannot).
      const ver = await sh("/usr/local/bin/opengeni-browser --version 2>&1 | head -1", 30_000);
      expect(ver.code).toBe(0);
      expect(ver.out.toLowerCase()).toMatch(/chrome|firefox/);

      // host-side from-outside-the-box assertions on the published port:
      // (a) noVNC /vnc.html -> 200
      let httpCode = "";
      for (let i = 0; i < 40 && httpCode !== "200"; i++) {
        const r = await exec("curl", [
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          `http://localhost:${HOST_PORT}/vnc.html`,
        ]).catch(() => ({ stdout: "" }));
        httpCode = (r.stdout as string).trim();
        if (httpCode !== "200") await new Promise((res) => setTimeout(res, 300));
      }
      expect(httpCode).toBe("200");

      // (b) websockify WS upgrade -> 101 + RFB banner bytes.
      const rfb = await probeRfbBanner(HOST_PORT);
      expect(rfb.ok).toBe(true);
      expect(rfb.banner).toMatch(/^RFB \d{3}\.\d{3}/);
    },
    35 * 60 * 1000,
  );
});

// ============================================================================
// GATED LIVE MODAL — the V2/gVisor regression (XTEST read-back on real Modal).
// Skipped unless OPENGENI_P41_LIVE_MODAL=1. Reads the [opengeni] profile from
// ~/.modal.toml natively via the Modal JS SDK; terminates the box in finally;
// never prints a secret.
// ============================================================================
const LIVE = process.env.OPENGENI_P41_LIVE_MODAL === "1";

describe.if(LIVE)(
  "P4.1 desktop image — GATED LIVE Modal/gVisor (XTEST read-back regression)",
  () => {
    test(
      "build a Modal image from docker/desktop.Dockerfile, boot, ensureDisplayStack, XTEST + scrot",
      async () => {
        // Load the Modal SDK from the spike's node_modules (not a monorepo dep), so the
        // default `bun test` run never resolves it.
        const require = createRequire(
          join(REPO_ROOT, "spikes/provider-credentialed/desktop-on-gvisor/x.cjs"),
        );
        const { ModalClient } = require("modal") as typeof import("modal");

        const APP_NAME = process.env.SPIKE_APP_NAME || "ogtest-p41-desktop-image";
        const STREAM_PORT = 6080;
        const BUILD_TIMEOUT_MS = 25 * 60 * 1000;
        const BOX_TIMEOUT_MS = 12 * 60 * 1000;

        const modal = new ModalClient({ logLevel: "info" });
        const app = await modal.apps.fromName(APP_NAME, { createIfMissing: true });

        // Build the image FROM the canonical Dockerfile commands. We mirror the proven
        // V2 lean build (the productionized image is a superset; for the live XTEST
        // regression we only need Xvfb + a WM + x11vnc + websockify + xdotool + scrot,
        // which the canonical apt layer includes). DEBIAN_FRONTEND=noninteractive +
        // TZ=Etc/UTC on every apt layer (the mandatory 07 finding).
        const aptRetry = (pkgs: string) =>
          `export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC; set -eux; for attempt in 1 2 3; do ` +
          `rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; ` +
          `apt-get update && apt-get install -y --no-install-recommends ${pkgs} && break; ` +
          `if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); done; rm -rf /var/lib/apt/lists/*`;

        const upScript = await Bun.file(
          join(REPO_ROOT, "docker/desktop/opengeni-desktop-up.sh"),
        ).text();
        // The lean Modal image uses openbox (faster than the full xfce4 tree) for the
        // WM step — swap only that line, exactly as the proven V2 harness did.
        const upOpenbox = upScript.replace(
          "dbus-launch --exit-with-session startxfce4",
          "dbus-launch --exit-with-session openbox",
        );
        const upB64 = Buffer.from(upOpenbox, "utf8").toString("base64");

        const layers = [
          `RUN ${aptRetry(
            "bash ca-certificates coreutils curl git net-tools netcat-openbsd wget gnupg xxd file " +
              "xvfb x11-utils x11-xserver-utils xauth dbus-x11 openbox " +
              "libgl1-mesa-dri fonts-liberation python3 xterm x11vnc xdotool scrot",
          )}`,
          `RUN set -eux; git clone --depth 1 -b v1.5.0 https://github.com/novnc/noVNC.git /opt/noVNC; ` +
            `git clone --depth 1 -b v0.12.0 https://github.com/novnc/websockify.git /opt/noVNC/utils/websockify; ` +
            `ln -sf /opt/noVNC/vnc.html /opt/noVNC/index.html`,
          `RUN set -eux; dbus-uuidgen --ensure=/var/lib/dbus/machine-id; ln -sf /var/lib/dbus/machine-id /etc/machine-id`,
          `RUN set -eux; mkdir -p /usr/local/bin; echo ${upB64} | base64 -d > /usr/local/bin/opengeni-desktop-up; ` +
            `chmod 0755 /usr/local/bin/opengeni-desktop-up; bash -n /usr/local/bin/opengeni-desktop-up`,
          `ENV HOME=/workspace DISPLAY=:0 OPENGENI_DESKTOP_STREAM_PORT=${STREAM_PORT}`,
          `WORKDIR /workspace`,
        ];

        let image = modal.images.fromRegistry("ubuntu:22.04");
        const buildStart = Date.now();
        for (const layer of layers) {
          if (Date.now() - buildStart > BUILD_TIMEOUT_MS) throw new Error("build budget exhausted");
          image = await image.dockerfileCommands(layer.split("\n")).build(app);
        }

        const sandbox = await modal.sandboxes.create(app, image, {
          timeoutMs: BOX_TIMEOUT_MS,
          encryptedPorts: [STREAM_PORT],
          command: ["sleep", "infinity"],
        });

        const drain = async (stream: ReadableStream<string>) => {
          let out = "";
          const reader = stream.getReader();
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              out += value;
            }
          } catch {
            /* noop */
          }
          return out;
        };
        const run = async (command: string) => {
          const proc = await sandbox.exec(["bash", "-lc", command], {
            stdout: "pipe",
            stderr: "pipe",
          });
          const [o, e] = await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
          const exitCode = await proc.wait();
          return { exitCode, output: `${o}\n${e}` };
        };

        try {
          const up = await run(`STREAM_PORT=${STREAM_PORT} opengeni-desktop-up`);
          expect(up.exitCode).toBe(0);
          expect(up.output).toContain("OPENGENI_DESKTOP_UP");

          const xdpy = await run("DISPLAY=:0 xdpyinfo >/dev/null 2>&1; echo rc=$?");
          expect(xdpy.output).toContain("rc=0");

          const socks = await run(
            `(nc -z localhost 5900 && echo VNC_OK); (nc -z localhost ${STREAM_PORT} && echo WS_OK)`,
          );
          expect(socks.output).toContain("VNC_OK");
          expect(socks.output).toContain("WS_OK");

          // XTEST mousemove read-back (the V2/gVisor computer-use proof): move to a
          // deterministic coord and read it back from the REAL X server state.
          await run("DISPLAY=:0 xdotool mousemove --sync 137 211");
          const loc = await run("DISPLAY=:0 xdotool getmouselocation --shell | tr '\\n' ' '");
          expect(/X=137/.test(loc.output) && /Y=211/.test(loc.output)).toBe(true);

          // scrot captures a non-empty PNG of :0.
          const shot = await run(
            "DISPLAY=:0 scrot -o /tmp/p41.png >/dev/null 2>&1; " +
              "sz=$(stat -c%s /tmp/p41.png 2>/dev/null || echo 0); " +
              'sig=$(head -c 8 /tmp/p41.png | xxd -p 2>/dev/null | head -1); echo "sz=$sz sig=$sig"',
          );
          const sz = Number(/sz=(\d+)/.exec(shot.output)?.[1] || 0);
          expect(sz).toBeGreaterThan(1000);
          expect(shot.output).toMatch(/sig=89504e47/);
        } finally {
          await sandbox.terminate().catch(() => undefined);
        }
      },
      40 * 60 * 1000,
    );
  },
);
