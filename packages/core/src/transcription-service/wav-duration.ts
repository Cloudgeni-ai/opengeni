/**
 * Duration of a PCM RIFF/WAVE buffer the server itself produced (resumable
 * provider segments are ffmpeg-normalized WAV). Used only as the trusted
 * billing fallback when a provider reports no usage; never applied to
 * client-uploaded bytes. Returns null for anything that is not a well-formed
 * WAV with a positive byte rate.
 */
export function wavDurationSeconds(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE") return null;
  let offset = 12;
  let byteRate: number | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 12 <= bytes.byteLength) {
      byteRate = view.getUint32(body + 8, true);
    } else if (id === "data") {
      if (!byteRate) return null;
      // Streamed WAV writes a placeholder size; the actual payload is the rest.
      const available = bytes.byteLength - body;
      const dataBytes = size === 0 || size === 0xffffffff ? available : Math.min(size, available);
      return dataBytes / byteRate;
    }
    offset = body + size + (size % 2);
  }
  return null;
}

function ascii(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}
