/**
 * ADTS: the AAC stream the native recorder writes. Every frame starts with
 * its own 7-byte header (9 with a CRC), so frames concatenate across chunk
 * files, and a file cut short by a crash is good up to its last whole frame.
 */

const SAMPLE_RATES = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
  7_350,
] as const;

export type AdtsFrame = { offset: number; length: number; samples: number; sampleRate: number };

/** The ADTS frame header at `offset`, or null when there is no whole frame there. */
export function readAdtsFrame(bytes: Uint8Array, offset: number): AdtsFrame | null {
  if (offset + 7 > bytes.length) return null;
  if (bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xf6) !== 0xf0) return null;
  const sampleRate = SAMPLE_RATES[(bytes[offset + 2]! >> 2) & 0x0f];
  if (!sampleRate) return null;
  const length =
    ((bytes[offset + 3]! & 0x03) << 11) | (bytes[offset + 4]! << 3) | (bytes[offset + 5]! >> 5);
  const headerLength = (bytes[offset + 1]! & 0x01) === 1 ? 7 : 9;
  if (length < headerLength || offset + length > bytes.length) return null;
  const samples = ((bytes[offset + 6]! & 0x03) + 1) * 1024;
  return { offset, length, samples, sampleRate };
}

/** How much of `bytes` is whole ADTS frames from the start, and how long they play. */
export function wholeAdtsFrames(bytes: Uint8Array): {
  byteLength: number;
  frames: number;
  durationMilliseconds: number;
} {
  let offset = 0;
  let frames = 0;
  let milliseconds = 0;
  for (;;) {
    const frame = readAdtsFrame(bytes, offset);
    if (!frame) break;
    frames += 1;
    milliseconds += (frame.samples * 1_000) / frame.sampleRate;
    offset += frame.length;
  }
  return { byteLength: offset, frames, durationMilliseconds: Math.round(milliseconds) };
}
