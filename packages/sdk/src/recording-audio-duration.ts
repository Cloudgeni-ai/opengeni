/**
 * How long an audio file plays and when it was recorded, read from its
 * container without decoding it, for files a person brings in (a phone's call
 * recording or voice memo) that the app knows nothing else about.
 *
 * Only MP4 (M4A) is read: its movie header states both. Other containers
 * return null, and the worker measures their length when it prepares the
 * audio.
 */
export function audioFileDurationMilliseconds(bytes: Uint8Array): number | null {
  const header = movieHeader(bytes);
  if (!header || !header.timescale || header.duration === null) return null;
  const milliseconds = Math.round((header.duration * 1000) / header.timescale);
  return milliseconds > 0 ? milliseconds : null;
}

/** Seconds from the MP4 epoch (1904-01-01) to the Unix epoch. */
const MP4_EPOCH_SECONDS = 2_082_844_800;

/** When an MP4 (M4A) file says it was recorded; null when it doesn't say or it's another container. */
export function audioFileCreatedAt(bytes: Uint8Array): Date | null {
  const created = movieHeader(bytes)?.created ?? 0;
  if (created <= MP4_EPOCH_SECONDS) return null;
  return new Date((created - MP4_EPOCH_SECONDS) * 1000);
}

function movieHeader(
  bytes: Uint8Array,
): { created: number; timescale: number; duration: number | null } | null {
  const moov = findBox(bytes, 0, bytes.byteLength, "moov");
  if (!moov) return null;
  const mvhd = findBox(bytes, moov.contentStart, moov.end, "mvhd");
  if (!mvhd || mvhd.end - mvhd.contentStart < 20) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = bytes[mvhd.contentStart]!;
  let created: number;
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (mvhd.end - mvhd.contentStart < 32) return null;
    created = Number(view.getBigUint64(mvhd.contentStart + 4));
    timescale = view.getUint32(mvhd.contentStart + 20);
    duration = Number(view.getBigUint64(mvhd.contentStart + 24));
    // All ones means "unknown".
    if (view.getBigUint64(mvhd.contentStart + 24) === 0xffffffffffffffffn) duration = NaN;
  } else {
    created = view.getUint32(mvhd.contentStart + 4);
    timescale = view.getUint32(mvhd.contentStart + 12);
    duration = view.getUint32(mvhd.contentStart + 16);
    if (duration === 0xffffffff) duration = NaN;
  }
  return {
    created,
    timescale,
    duration: Number.isFinite(duration) ? duration : null,
  };
}

function findBox(
  bytes: Uint8Array,
  start: number,
  end: number,
  type: string,
): { contentStart: number; end: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return null;
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) return null;
    const name = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    if (name === type) return { contentStart: offset + header, end: offset + size };
    offset += size;
  }
  return null;
}
