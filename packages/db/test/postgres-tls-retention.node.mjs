// This small subprocess fixture runs the actual patched driver under Node,
// where the Bun-only raw-stream drain must remain inactive.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import net from "node:net";
import { pathToFileURL } from "node:url";

const [driverPath, port, transport, digest] = process.argv.slice(2);
const { default: postgres } = await import(pathToFileURL(driverPath).href);
const sockets = [];
const deadline = setTimeout(() => {
  console.error("Node regression subprocess exceeded 7s");
  process.exit(1);
}, 7_000);
const client = postgres({
  host: "127.0.0.1",
  port: Number(port),
  user: "test",
  database: "test",
  max: 1,
  prepare: false,
  fetch_types: false,
  connect_timeout: 2,
  max_lifetime: 0,
  ssl: transport === "plain" ? false : { rejectUnauthorized: false },
  sslnegotiation: transport === "direct" ? "direct" : undefined,
  socket: async () => {
    const raw = net.connect({ host: "127.0.0.1", port: Number(port) });
    sockets.push(raw);
    await new Promise((resolve, reject) => {
      raw.once("error", reject);
      raw.once("connect", () => {
        raw.removeListener("error", reject);
        resolve();
      });
    });
    return raw;
  },
});
try {
  assert.equal(typeof globalThis.Bun, "undefined");
  for (let round = 0; round < 3; round++) {
    const rows = await client.unsafe("select fixture_payload").simple();
    assert.equal(rows.length, 1);
    assert.equal(createHash("sha256").update(rows[0].payload).digest("hex"), digest);
    assert.ok(sockets[0].readableLength <= 64 * 1024);
    if (transport !== "plain") assert.equal(sockets[0].listenerCount("data"), 0);
  }
  assert.equal(sockets.length, 1);
  await client.end({ timeout: 1 });
  assert.equal(sockets[0].destroyed, true);
  console.log(JSON.stringify({ queries: 3, queueLimit: 64 * 1024, bun: false }));
} finally {
  for (const raw of sockets) raw.destroy();
  clearTimeout(deadline);
}
