// Resolves the front door's names, `api.<domain>` and `<port>-<id>.<domain>`,
// to this machine, so the SDK reaches it by the names it builds itself.
// Loaded with `node --require ./resolve.cjs`.
const dns = require("node:dns");

const domain = (process.env.CONFORMANCE_DOMAIN ?? "e2b.test").toLowerCase();
const original = dns.lookup;

function ours(hostname) {
  const name = String(hostname).toLowerCase();
  return name === domain || name.endsWith(`.${domain}`);
}

dns.lookup = function lookup(hostname, options, callback) {
  if (!ours(hostname)) return original.call(this, hostname, options, callback);
  const done = typeof options === "function" ? options : callback;
  const all = typeof options === "object" && options !== null && options.all;
  if (all) process.nextTick(done, null, [{ address: "127.0.0.1", family: 4 }]);
  else process.nextTick(done, null, "127.0.0.1", 4);
  return {};
};
