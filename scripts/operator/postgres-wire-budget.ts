/** Count cleartext PostgreSQL response boundaries without retaining SQL/values.
 * Local fixtures use one startup packet (no TLS negotiation), then typed frames.
 * Q = simple query, H = describe flush, S = extended-query sync. These count
 * protocol response cycles, not TCP packets or a serial critical-path length.
 */
export function postgresWireBudget(onBoundary: (type: "Q" | "H" | "S") => void) {
  let startup = true;
  let header = Buffer.alloc(0);
  let remaining = 0;
  return (chunk: Buffer) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (remaining > 0) {
        const skipped = Math.min(remaining, chunk.length - offset);
        remaining -= skipped;
        offset += skipped;
        continue;
      }
      const size = startup ? 4 : 5;
      const take = Math.min(size - header.length, chunk.length - offset);
      header = Buffer.concat([header, chunk.subarray(offset, offset + take)]);
      offset += take;
      if (header.length < size) continue;
      const length = header.readInt32BE(startup ? 0 : 1);
      if (length < 4) throw new Error("Invalid PostgreSQL frame length");
      if (!startup) {
        const type = String.fromCharCode(header[0]!);
        if (type === "Q" || type === "H" || type === "S") onBoundary(type);
      }
      remaining = length - 4;
      startup = false;
      header = Buffer.alloc(0);
    }
  };
}
