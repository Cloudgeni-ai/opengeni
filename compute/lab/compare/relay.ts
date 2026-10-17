/**
 * Relays TCP connections to the host agent's Unix socket, so a benchmark
 * client on another VM speaks the agent's own protocol over one plain hop.
 * Lab use only: the agent's socket has no authentication, so the relay takes
 * connections from the listed client addresses alone.
 *
 *   bun relay.ts --listen 10.0.0.4:7000 --socket /run/compute-host.sock --allow 10.0.0.5
 */
import { connect, createServer } from "node:net";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    listen: { type: "string" },
    socket: { type: "string", default: "/run/compute-host.sock" },
    allow: { type: "string", multiple: true, default: [] },
  },
});
if (!values.listen || values.allow.length === 0) {
  console.error("usage: relay.ts --listen HOST:PORT --socket PATH --allow CLIENT_IP [--allow ...]");
  process.exit(2);
}
const colon = values.listen.lastIndexOf(":");
const host = values.listen.slice(0, colon);
const port = Number(values.listen.slice(colon + 1));
const allowed = new Set(values.allow.map((address) => address.replace(/^::ffff:/, "")));

const server = createServer((client) => {
  const peer = (client.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (!allowed.has(peer)) {
    client.destroy();
    return;
  }
  client.setNoDelay(true);
  const agent = connect(values.socket as string);
  client.pipe(agent);
  agent.pipe(client);
  const close = () => {
    client.destroy();
    agent.destroy();
  };
  client.on("error", close);
  agent.on("error", close);
  client.on("close", () => agent.end());
  agent.on("close", () => client.end());
});
server.listen(port, host, () => console.log(`relaying ${values.listen} to ${values.socket} for ${[...allowed].join(", ")}`));
