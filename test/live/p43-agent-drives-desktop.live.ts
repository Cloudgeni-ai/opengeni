// P4.3 — THE HEADLINE live proof: the agent drives the SAME desktop a human
// watches, and films itself doing it.
//
// On a REAL Modal/gVisor box booted from the P4.1 canonical desktop image:
//   1. ensureDisplayStack (Xvfb :0 → WM → x11vnc → websockify:6080).
//   2. start ffmpeg x11grab recording :0 (the recording loop, P4.3).
//   3. drive computer-use via the PRODUCTION SandboxComputer: xdotool mousemove
//      to a deterministic coord (read back from the REAL X server — the XTEST
//      proof) + open xterm + TYPE A NONCE; screenshot via SandboxComputer
//      (readFile of the scrot PNG — NOT banner-wrapped execCommand, the F2 fix).
//   4. stop + finalize the recording (direct box → object-storage PUT → assert a
//      non-empty mp4 → the recording.available outcome with the artifact ref).
//   5. save the produced recording to docs/.../evidence/P4.3-agent-drives-desktop.mp4.
//   6. terminate the box in finally (the lease owns lifecycle in prod; here we do).
//
// The agent and the human share ONE :0: ffmpeg records exactly the pixels
// xdotool draws — zero projection. This is "watch the agent prove the fix".
//
// Gating: OPENGENI_P43_LIVE_MODAL=1. Reads the [opengeni] profile from
// ~/.modal.toml natively via the Modal JS SDK (set MODAL_PROFILE=opengeni).
// Terminates the box in finally on every path; never prints a secret.
//
// Run: OPENGENI_P43_LIVE_MODAL=1 MODAL_PROFILE=opengeni \
//      bun test ./test/live/p43-agent-drives-desktop.live.ts

import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSettings } from "@opengeni/config";
import {
  SandboxComputer,
  deleteRecordingArtifacts,
  startRecording,
  stopRecording,
  uploadRecordingArtifact,
  recordingStorageKey,
  contentTypeForCodec,
} from "@opengeni/runtime";
import { createObjectStorage } from "@opengeni/storage";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const EVIDENCE = join(
  REPO_ROOT,
  "docs/design/sandbox-surfacing/evidence/P4.3-agent-drives-desktop.mp4",
);
const LIVE = process.env.OPENGENI_P43_LIVE_MODAL === "1";

describe.if(LIVE)("P4.3 — agent drives + records the desktop (GATED LIVE Modal/gVisor)", () => {
  test(
    "computer-use drives :0, ffmpeg films it, finalize yields a non-empty mp4 + recording.available",
    async () => {
      // The Modal SDK lives in the spike node_modules (not a monorepo dep), so the
      // default `bun test` run never resolves it.
      const require = createRequire(
        join(REPO_ROOT, "spikes/provider-credentialed/desktop-on-gvisor/x.cjs"),
      );
      const { ModalClient } = require("modal") as typeof import("modal");

      const APP_NAME = process.env.SPIKE_APP_NAME || "ogtest-p43-agent-desktop";
      const STREAM_PORT = 6080;
      const BUILD_TIMEOUT_MS = 25 * 60 * 1000;
      const BOX_TIMEOUT_MS = 14 * 60 * 1000;
      const W = 1280,
        H = 800;

      const modal = new ModalClient({ logLevel: "info" });
      const app = await modal.apps.fromName(APP_NAME, { createIfMissing: true });
      const objectStorage = createObjectStorage(getSettings());
      if (!objectStorage) throw new Error("P4.3 live proof requires configured object storage");

      // Build the lean desktop image (the same productionized-superset apt layer the
      // P4.1 live regression uses): Xvfb + WM + x11vnc + websockify + xdotool + scrot
      // + ffmpeg (the recording dep). DEBIAN_FRONTEND=noninteractive + TZ=Etc/UTC on
      // every apt layer (the mandatory 07 finding — the xfce4 tree's tzdata otherwise
      // blocks the builder forever).
      const aptRetry = (pkgs: string) =>
        `export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC; set -eux; for attempt in 1 2 3; do ` +
        `rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/partial/*; ` +
        `apt-get update && apt-get install -y --no-install-recommends ${pkgs} && break; ` +
        `if [ "$attempt" = "3" ]; then exit 1; fi; sleep $((attempt * 5)); done; rm -rf /var/lib/apt/lists/*`;

      const upScript = await Bun.file(
        join(REPO_ROOT, "docker/desktop/opengeni-desktop-up.sh"),
      ).text();
      const upOpenbox = upScript.replace(
        "dbus-launch --exit-with-session startxfce4",
        "dbus-launch --exit-with-session openbox",
      );
      const upB64 = Buffer.from(upOpenbox, "utf8").toString("base64");

      const layers = [
        `RUN ${aptRetry(
          "bash ca-certificates coreutils curl git net-tools netcat-openbsd wget gnupg xxd file " +
            "xvfb x11-utils x11-xserver-utils xauth dbus-x11 openbox " +
            "libgl1-mesa-dri fonts-liberation python3 xterm x11vnc xdotool scrot ffmpeg",
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
      // The raw Modal exec returns CLEAN stdout (no SDK banner preamble). The
      // adapter below wraps it into the SDK session contract SandboxComputer +
      // the recording loop expect: `execCommand` returns the formatted-string shape
      // (so the preamble parsers see a real exit code), and `readFile` returns RAW
      // bytes (base64 over the clean exec stdout — the F2-correct screenshot path:
      // SandboxComputer.screenshot reads the PNG via readFile, never base64-via-exec).
      const rawRun = async (command: string): Promise<{ exitCode: number; stdout: string }> => {
        const proc = await sandbox.exec(["bash", "-lc", command], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [o] = await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
        const exitCode = await proc.wait();
        return { exitCode, stdout: o };
      };
      const session = {
        execCommand: async (args: { cmd: string }): Promise<string> => {
          const r = await rawRun(args.cmd);
          // Mirror formatExecResponse: a preamble carrying the exit code + Output body.
          return `Chunk ID: live\nWall time: 0.0 seconds\nProcess exited with code ${r.exitCode}\nOutput:\n${r.stdout}`;
        },
        readFile: async (args: { path: string }): Promise<Uint8Array> => {
          // Read the file as base64 over clean exec stdout, decode to raw bytes.
          const r = await rawRun(`base64 -w0 ${args.path}`);
          if (r.exitCode !== 0) throw new Error(`readFile failed for ${args.path}`);
          return Uint8Array.from(Buffer.from(r.stdout.trim(), "base64"));
        },
      };

      let terminated = false;
      let storageKey: string | null = null;
      const terminate = async () => {
        if (terminated) return;
        terminated = true;
        await sandbox.terminate().catch(() => undefined);
      };

      try {
        // 1) Bring the display stack up (ensureDisplayStack equiv via the up-script).
        const up = await rawRun(`STREAM_PORT=${STREAM_PORT} opengeni-desktop-up`);
        expect(up.exitCode).toBe(0);
        expect(up.stdout).toContain("OPENGENI_DESKTOP_UP");

        // 2) Start the recording (ffmpeg x11grab on :0) — the production loop.
        const recordingId = crypto.randomUUID();
        const proc = await startRecording(session, {
          recordingId,
          codec: "h264-mp4",
          framerate: 15,
          maxSeconds: 120,
          dimensions: [W, H],
        });

        // 3) Drive computer-use via the PRODUCTION SandboxComputer on the SAME :0.
        const computer = new SandboxComputer(session as never, { dimensions: [W, H] });

        // 3a) XTEST mousemove read-back — the agent's input reaches the real X server.
        await computer.move(137, 211);
        const loc = await rawRun("DISPLAY=:0 xdotool getmouselocation --shell | tr '\\n' ' '");
        expect(/X=137/.test(loc.stdout) && /Y=211/.test(loc.stdout)).toBe(true);

        // 3b) Open a terminal and type a NONCE the agent "proves" (visible on :0).
        const nonce = `OG-P43-${recordingId.slice(0, 8)}`;
        await rawRun("DISPLAY=:0 nohup xterm -geometry 100x30+50+50 >/dev/null 2>&1 & sleep 2");
        await computer.move(300, 200);
        await computer.click(300, 200, "left");
        await computer.type(`echo ${nonce}`);
        await computer.keypress(["Return"]);
        // Let the nonce render + a couple of frames capture.
        await new Promise((r) => setTimeout(r, 2500));

        // 3c) Screenshot via SandboxComputer (readFile of the scrot PNG — the F2 fix).
        const shotB64 = await computer.screenshot();
        const shotBytes = Buffer.from(shotB64, "base64");
        expect(shotBytes.length).toBeGreaterThan(1000);
        // PNG magic 89 50 4e 47 — proves the screenshot is a real image, NOT a
        // banner-wrapped string (F2: the corrupt-payload bug this rules out).
        expect(shotBytes.subarray(0, 4).toString("hex")).toBe("89504e47");

        // Drive a little more so the recording has motion to capture.
        await computer.move(600, 400);
        await computer.move(200, 300);
        await new Promise((r) => setTimeout(r, 1500));

        // 4) Stop + finalize the recording. The box uploads directly to the
        // short-lived scoped URL; the recording bytes never enter worker memory
        // or a Temporal payload (F10).
        await stopRecording(session, proc);
        storageKey = recordingStorageKey("live-ws", "live-sess", recordingId, "h264-mp4");
        const upload = await objectStorage.createPutUrl({
          key: storageKey,
          contentType: contentTypeForCodec("h264-mp4"),
        });
        const finalized = await uploadRecordingArtifact(session, proc, {
          url: upload.url,
          requiredHeaders: upload.requiredHeaders,
          maxBytes: 256 * 1024 * 1024,
        });
        expect(finalized.sizeBytes).toBeGreaterThan(1000); // a non-empty mp4
        expect(finalized.contentType).toBe("video/mp4");
        const stored = await objectStorage.getObjectBytes(storageKey);
        if (!stored) throw new Error(`Recording upload missing from storage: ${storageKey}`);
        const bytes = stored.bytes;
        expect(finalized.sizeBytes).toBe(bytes.length);
        // ffmpeg mp4: ISO-BMFF — bytes 4..8 are the 'ftyp' box type.
        expect(Buffer.from(bytes.subarray(4, 8)).toString("latin1")).toBe("ftyp");
        await deleteRecordingArtifacts(session, proc);

        // The recording.available artifact ref the event would carry (the storage
        // key the finalize activity PUTs to; here we assert the shape + persist
        // the bytes as the prove-it evidence).
        expect(storageKey).toBe(`recordings/live-ws/live-sess/${recordingId}.mp4`);
        expect(contentTypeForCodec("h264-mp4")).toBe("video/mp4");

        // 5) Save the produced recording as the first prove-it artifact.
        await mkdir(dirname(EVIDENCE), { recursive: true });
        await writeFile(EVIDENCE, bytes);
        const stat = Bun.file(EVIDENCE);
        expect(await stat.exists()).toBe(true);
        expect(await stat.size).toBe(bytes.length);

        // eslint-disable-next-line no-console
        console.log(
          `[P4.3 LIVE] agent drove :0 + filmed itself — mp4 ${bytes.length}B ` +
            `(${finalized.durationSeconds}s) → ${EVIDENCE}; recording.available ref=${storageKey}; nonce=${nonce}`,
        );
      } finally {
        if (storageKey) await objectStorage.deleteObject(storageKey).catch(() => undefined);
        // 6) Terminate the box (the lease owns lifecycle in prod; here we do).
        await terminate();
      }
    },
    45 * 60 * 1000,
  );
});
