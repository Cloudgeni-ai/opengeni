// Stands in for the system audio helper in tests: reports a start, writes a
// ramp of float samples, and stops when stdin closes. FAKE_CAPTURE_MODE=error
// fails like a denied permission; =crash exits without saying why.
const mode = process.env.FAKE_CAPTURE_MODE ?? "ok";
const args = process.argv.slice(2).join(" ");
if (mode === "error") {
  process.stderr.write(
    `${JSON.stringify({ event: "error", code: "permission_denied", message: "denied" })}\n`,
  );
  process.exit(1);
}
if (mode === "crash") process.exit(3);
process.stderr.write(
  `${JSON.stringify({ event: "started", sampleRate: 1000, channels: 1, backend: "fake", args })}\n`,
);
// 250 samples (a quarter second at 1 kHz) in odd-sized writes, so the reader
// has to join samples split across chunks.
const samples = new Float32Array(250).map((_, index) => index / 1000);
const bytes = Buffer.from(samples.buffer);
for (let offset = 0; offset < bytes.length; offset += 37) {
  process.stdout.write(
    bytes.subarray(offset, Math.min(bytes.length, offset + 37)),
  );
}
process.stdin.on("data", () => undefined);
process.stdin.on("end", () => {
  process.stderr.write(
    `${JSON.stringify({ event: "stopped", droppedSamples: 0 })}\n`,
  );
  process.exit(0);
});
