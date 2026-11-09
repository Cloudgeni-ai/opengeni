import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALIGNER_BYTES, MemoryBudget } from "../src/activities/recording-memory";
import { createLocalAligner } from "../src/activities/recording-speakers";
import { ffmpegPath, hasFfmpeg, opusWebm } from "./recording-audio-fixtures";

let directory = "";

// Stands in for `opengeni-speakers align-serve`: notes each start, then for
// each request runs its decoder and places every word at the length of the
// audio it read, or fails the way the real one does.
const FAKE_SERVER = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const log = process.argv[process.argv.indexOf("--models") + 1] + "/log";
const sessions = Number(process.argv[process.argv.indexOf("--sessions") + 1]);
appendFileSync(log, "start " + sessions + "\\n");
console.log(JSON.stringify({ ready: true, sessions: Math.min(sessions, 2) }));
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (request.words[0] === "crash") process.exit(3);
    if (request.words[0] === "fail") {
      console.log(JSON.stringify({ id: request.id, error: "no speech" }));
      continue;
    }
    const decoder = Bun.spawnSync(request.decode);
    const ms = Math.round((decoder.stdout.length / 64000) * 1000);
    console.log(JSON.stringify({
      id: request.id,
      words: request.words.map(() => ({ startMs: 0, endMs: ms, score: -0.5 })),
      anchoredWords: 0, spreadWords: 0, untimedWords: 0, elapsedMs: 1,
    }));
  }
}
appendFileSync(log, "exit\\n");
`;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "aligner-test-"));
  await writeFile(join(directory, "speakers"), FAKE_SERVER);
  await chmod(join(directory, "speakers"), 0o755);
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** A models directory of its own, so each test reads only its aligner's starts. */
const modelsDir = async (name: string) => {
  const path = join(directory, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "log"), "");
  return path;
};

const log = async (models: string) =>
  (await readFile(join(models, "log"), "utf8")).trim().split("\n");

describe("the local aligner", () => {
  test.skipIf(!hasFfmpeg)(
    "aligns every piece with one loaded model, then exits and gives its memory back",
    async () => {
      const models = await modelsDir("shared");
      const memory = new MemoryBudget(10 * ALIGNER_BYTES);
      const aligner = createLocalAligner({
        binaryPath: join(directory, "speakers"),
        modelsDir: models,
        ffmpegPath,
        memory,
        alignerIdleMilliseconds: 200,
      });
      const audio = (seconds: number) => ({
        bytes: opusWebm(seconds),
        mimeType: "audio/webm",
        fileName: "piece.webm",
      });
      const [two, three] = await Promise.all([
        aligner.align(audio(2), ["hello", "there"], {}),
        aligner.align(audio(3), ["again"], {}),
      ]);
      // Each heard its own audio, decoded to 16 kHz float PCM.
      expect(two.words).toHaveLength(2);
      expect(two.words[0]!.endMilliseconds).toBeGreaterThan(1_900);
      expect(two.words[0]!.endMilliseconds).toBeLessThan(2_100);
      expect(three.words[0]!.endMilliseconds).toBeGreaterThan(2_900);
      // Memory allowed four copies; it loaded two and gave the rest back.
      expect(await log(models)).toEqual(["start 4"]);
      expect(memory.outBytes).toBe(2 * ALIGNER_BYTES);
      await expect(aligner.align(audio(1), ["fail"], {})).rejects.toThrow(
        "speaker models failed: no speech",
      );
      await Bun.sleep(600);
      expect(await log(models)).toEqual(["start 4", "exit"]);
      expect(memory.outBytes).toBe(0);
      // The next piece loads it again.
      await aligner.align(audio(1), ["back"], {});
      expect(await log(models)).toEqual(["start 4", "exit", "start 4"]);
    },
  );

  test.skipIf(!hasFfmpeg)("fails what it was asked when it stops, and starts afresh", async () => {
    const models = await modelsDir("crash");
    // Room for one copy only.
    const memory = new MemoryBudget(ALIGNER_BYTES);
    const aligner = createLocalAligner({
      binaryPath: join(directory, "speakers"),
      modelsDir: models,
      ffmpegPath,
      memory,
      alignerIdleMilliseconds: 10_000,
    });
    const audio = { bytes: opusWebm(1), mimeType: "audio/webm", fileName: "piece.webm" };
    await expect(aligner.align(audio, ["crash"], {})).rejects.toThrow("the aligner stopped");
    const after = await aligner.align(audio, ["fine"], {});
    expect(after.words).toHaveLength(1);
    expect(await log(models)).toEqual(["start 1", "start 1"]);
  });

  test.skipIf(!hasFfmpeg)(
    "an idle aligner exits at once when speaker detection waits for its memory",
    async () => {
      const models = await modelsDir("wanted");
      const memory = new MemoryBudget(ALIGNER_BYTES);
      const aligner = createLocalAligner({
        binaryPath: join(directory, "speakers"),
        modelsDir: models,
        ffmpegPath,
        memory,
        alignerIdleMilliseconds: 60_000,
      });
      const audio = { bytes: opusWebm(1), mimeType: "audio/webm", fileName: "piece.webm" };
      await aligner.align(audio, ["first"], {});
      expect(memory.outBytes).toBe(ALIGNER_BYTES);
      // Speaker detection asks for memory the idle aligner holds: it gets it
      // as soon as the aligner has exited, not a minute later.
      const started = performance.now();
      const release = await memory.take(ALIGNER_BYTES);
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(await log(models)).toEqual(["start 1", "exit"]);
      release();
      // Asked for while it is still aligning: it finishes the piece, then leaves.
      const next = aligner.align(audio, ["second"], {});
      await Bun.sleep(20);
      const later = memory.take(ALIGNER_BYTES);
      expect((await next).words).toHaveLength(1);
      (await later)();
      expect(await log(models)).toEqual(["start 1", "exit", "start 1", "exit"]);
    },
  );

  test("asks nothing for a piece without words", async () => {
    const aligner = createLocalAligner({
      binaryPath: join(directory, "missing"),
      modelsDir: directory,
      ffmpegPath,
    });
    const audio = { bytes: new Uint8Array(), mimeType: "audio/webm", fileName: "piece.webm" };
    expect(await aligner.align(audio, [], {})).toEqual({
      words: [],
      anchoredWords: 0,
      spreadWords: 0,
      untimedWords: 0,
    });
  });
});
