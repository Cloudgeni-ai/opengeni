import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ObjectStorage } from "@opengeni/storage";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  copyVersionedObjectToVerifiedTemp,
  validateGeneratedVideo,
} from "../src/activities/video-media-validation";

const FAST_START_MP4_BASE64 =
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAARFbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAD6AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAA3B0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAKAAAABaAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAA+gAAAQAAABAAAAAALobWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAABAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACk21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAlNzdGJsAAAAw3N0c2QAAAAAAAAAAQAAALNhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAKAAWgBIAAAASAAAAAAAAAABFUxhdmM2Mi4xMS4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAOWF2Y0MBZAAM/+EAG2dkAAyscgRCjfkwEQAAAwABAAADABAPFCmEYAEAB2joQ48TITD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAACcYAAAAAAAAAGHN0dHMAAAAAAAAAAQAAACAAAAgAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAACYY3R0cwAAAAAAAAARAAAAAQAAEAAAAAABAABQAAAAAAEAACAAAAAAAwAAAAAAAAAEAAAIAAAAAAEAAFAAAAAAAQAAIAAAAAADAAAAAAAAAAQAAAgAAAAAAQAAUAAAAAABAAAgAAAAAAMAAAAAAAAABAAACAAAAAABAAAoAAAAAAEAABAAAAAAAQAAAAAAAAABAAAIAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAIAAAAAEAAACUc3RzegAAAAAAAAAAAAAAIAAAAvAAAAASAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAYAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAZAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAbAAAADwAAAA8AAAAPAAAAFHN0Y28AAAAAAAAAAQAABHUAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYyLjMuMTAwAAAACGZyZWUAAATrbWRhdAAAArEGBf//rdxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjUgcjMyMjIgYjM1NjA1YSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjUgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0xNiBkZWJsb2NrPTE6LTM6LTMgYW5hbHlzZT0weDM6MHgxMzMgbWU9dW1oIHN1Ym1lPTEwIHBzeT0xIHBzeV9yZD0yLjAwOjAuNzAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MjQgY2hyb21hX21lPTEgdHJlbGxpcz0yIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS00IHRocmVhZHM9MyBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTggYl9weXJhbWlkPTIgYl9hZGFwdD0yIGJfYmlhcz0wIGRpcmVjdD0zIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49OCBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTYwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMjAAgAAAADdliIEAAtnP/u5U/gU3Ux6dNVNIZEntdeOrC8lPG1FX+m9QuWnDaKTjUGAGuz5TCtQUoABOwTwJAAAADkGaCS2ILZz//talUAPyAAAAC0GeEIcQUzn/AAS9AAAACwGeGCaII5z/ABFwAAAACwGeGEaII5z/ABFxAAAACwGeGGaII5z/ABFxAAAACwGeGK1II5z/ABFxAAAACwGeGM1II5z/ABFxAAAACwGeGO1II5z/ABFwAAAACwGeGQ1II5z/ABFwAAAAFEGaGkk1AgLRMpgQVzn//talUAPzAAAAC0GeIaXEFM5/AAS8AAAACwGeKUWiCOc/ABFwAAAACwGeKWWiCOc/ABFxAAAACwGeKYWiCOc/ABFxAAAACwGeKcySCOc/ABFxAAAACwGeKeySCOc/ABFwAAAACwGeKgySCOc/ABFwAAAACwGeKiySCOc/ABFxAAAAFUGaK2m1AgLa0TKYAQTzn/61KoAeMAAAAAtBnjLEsQUznwAEvAAAAAsBnjpkqII5zwARcQAAAAsBnjqEqII5zwARcAAAAAsBnjqkqII5zwARcQAAAAsBnjrs0gjnPwARcQAAAAsBnjsM0gjnPwARcAAAAAsBnjss0gjnPwARcQAAAAsBnjtM0gjnPwARcAAAABdBmjvojUCAtra0TKYABBHOf/61KoAeMQAAAAtBnkOk8QSznwANSQAAAAsBnkuE6II5zwARcAAAAAsBnkvMRII5zwARcA==";

let root = "";
let probe = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "opengeni-video-media-"));
  probe = join(root, "ffprobe-fixture");
  await writeFile(
    probe,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({
      streams: [
        {
          codec_name: "h264",
          codec_type: "video",
          width: 160,
          height: 90,
          avg_frame_rate: "8/1",
        },
      ],
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "4.000000" },
    })}'\n`,
    { mode: 0o700 },
  );
  await chmod(probe, 0o700);
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("video media validation", () => {
  test("accepts a browser-compatible H.264 MP4", async () => {
    const path = join(root, `valid-${randomUUID()}.mp4`);
    await writeFile(path, Buffer.from(FAST_START_MP4_BASE64, "base64"));
    expect(
      await validateGeneratedVideo({ path, ffprobePath: probe, expectedDurationSeconds: 4 }),
    ).toEqual({
      durationSeconds: 4,
      width: 160,
      height: 90,
      fps: 8,
      hasAudio: false,
      videoCodec: "h264",
      audioCodec: null,
    });
  });

  test("accepts provider MP4 metadata at the end for native Range playback", async () => {
    const bytes = Buffer.from(FAST_START_MP4_BASE64, "base64");
    const boxes = topLevelBoxes(bytes);
    const reordered = Buffer.concat([
      box(bytes, boxes, "ftyp"),
      box(bytes, boxes, "free"),
      box(bytes, boxes, "mdat"),
      box(bytes, boxes, "moov"),
    ]);
    const path = join(root, `slow-start-${randomUUID()}.mp4`);
    await writeFile(path, reordered);
    await expect(validateGeneratedVideo({ path, ffprobePath: probe })).resolves.toMatchObject({
      videoCodec: "h264",
      durationSeconds: 4,
    });
  });

  test("ignores an explicitly attached cover-art stream", async () => {
    const path = join(root, `cover-art-${randomUUID()}.mp4`);
    await writeFile(path, Buffer.from(FAST_START_MP4_BASE64, "base64"));
    const coverArtProbe = await writeProbeFixture({
      streams: [
        {
          codec_name: "h264",
          codec_type: "video",
          width: 480,
          height: 480,
          avg_frame_rate: "24/1",
          disposition: { attached_pic: 0 },
        },
        {
          codec_name: "aac",
          codec_type: "audio",
          avg_frame_rate: "0/0",
          disposition: { attached_pic: 0 },
        },
        {
          codec_name: "mjpeg",
          codec_type: "video",
          width: 480,
          height: 480,
          avg_frame_rate: "0/0",
          disposition: { attached_pic: 1 },
        },
      ],
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "4.041667" },
    });

    await expect(
      validateGeneratedVideo({ path, ffprobePath: coverArtProbe, expectedDurationSeconds: 4 }),
    ).resolves.toMatchObject({
      videoCodec: "h264",
      audioCodec: "aac",
      hasAudio: true,
      width: 480,
      height: 480,
    });
  });

  test("still rejects a second playable video stream", async () => {
    const path = join(root, `two-videos-${randomUUID()}.mp4`);
    await writeFile(path, Buffer.from(FAST_START_MP4_BASE64, "base64"));
    const twoVideoProbe = await writeProbeFixture({
      streams: [
        {
          codec_name: "h264",
          codec_type: "video",
          width: 480,
          height: 480,
          avg_frame_rate: "24/1",
        },
        {
          codec_name: "mjpeg",
          codec_type: "video",
          width: 480,
          height: 480,
          avg_frame_rate: "1/1",
        },
      ],
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "4.041667" },
    });

    await expect(validateGeneratedVideo({ path, ffprobePath: twoVideoProbe })).rejects.toThrow(
      "browser-compatible H.264 MP4",
    );
  });

  test("copies a version-fenced staged object in bounded ranges and verifies its digest", async () => {
    const bytes = Buffer.from(FAST_START_MP4_BASE64, "base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const ranges: Array<[number, number]> = [];
    const storage = {
      async headObject() {
        return {
          ContentLength: bytes.byteLength,
          ContentType: "video/mp4",
          Metadata: { sha256 },
          VersionToken: "version-1",
        };
      },
      async getObjectRange(input: { start: number; endInclusive: number }) {
        ranges.push([input.start, input.endInclusive]);
        return {
          bytes: bytes.subarray(input.start, input.endInclusive + 1),
          versionToken: "version-1",
        };
      },
    } as unknown as ObjectStorage;
    const copied = await copyVersionedObjectToVerifiedTemp({
      storage,
      key: "video-generation/staging/test",
      expectedSizeBytes: bytes.byteLength,
      expectedSha256: sha256,
      expectedContentType: "video/mp4",
      maxBytes: bytes.byteLength,
      tempRoot: root,
    });
    try {
      expect(Buffer.from(await readFile(copied.path))).toEqual(bytes);
      expect(copied.sha256).toBe(sha256);
      expect(ranges).toEqual([[0, bytes.byteLength - 1]]);
    } finally {
      await copied.cleanup();
    }
  });
});

async function writeProbeFixture(value: unknown): Promise<string> {
  const path = join(root, `ffprobe-${randomUUID()}`);
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(value)}'\n`, {
    mode: 0o700,
  });
  await chmod(path, 0o700);
  return path;
}

function topLevelBoxes(bytes: Buffer): Map<string, { offset: number; size: number }> {
  const boxes = new Map<string, { offset: number; size: number }>();
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (size < 8 || offset + size > bytes.byteLength) throw new Error("Invalid MP4 fixture");
    boxes.set(type, { offset, size });
    offset += size;
  }
  return boxes;
}

function box(
  bytes: Buffer,
  boxes: Map<string, { offset: number; size: number }>,
  type: string,
): Buffer {
  const found = boxes.get(type);
  if (!found) throw new Error(`Missing ${type} box in MP4 fixture`);
  return bytes.subarray(found.offset, found.offset + found.size);
}
