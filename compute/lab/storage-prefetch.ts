// Derive next-wake chunk hints from an earlier successful read trace.
import { readFileSync, writeFileSync } from "node:fs";
const [trace, destination] = process.argv.slice(2);
if (!trace || !destination) throw new Error("usage: storage-prefetch.ts TRACE OUTPUT");
const offsets = new Set<number>();
const chunk = Number(process.env.CHUNK_BYTES ?? 262144);
for (const line of readFileSync(trace, "utf8").trim().split("\n")) {
  const row = JSON.parse(line);
  if (row.event !== "request" || row.operation !== 0) continue;
  if (process.env.TRACE_CUTOFF_MS && row.elapsed_ms > Number(process.env.TRACE_CUTOFF_MS)) continue;
  for (let offset = Math.floor(row.offset / chunk) * chunk; offset < row.offset + row.length; offset += chunk) offsets.add(offset);
}
writeFileSync(destination, JSON.stringify([...offsets].sort((a, b) => a - b)));
console.log(JSON.stringify({ chunks: offsets.size }));
