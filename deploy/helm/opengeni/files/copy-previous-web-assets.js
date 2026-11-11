// Copies a previous web image's hashed asset directories for the current server.
// Never fails the pod: a missing or partial copy only means fewer old assets.
const fs = require("node:fs");
const path = require("node:path");

const source = process.env.OPENGENI_PREVIOUS_WEB_DIST || "/app/apps/web/dist";
const target = process.env.OPENGENI_PREVIOUS_WEB_ASSETS_TARGET;
let copied = 0;
if (target) {
  for (const directory of ["assets", "office/assets", "react-demo/assets"]) {
    const from = path.join(source, directory);
    try {
      if (!fs.statSync(from).isDirectory()) continue;
      fs.cpSync(from, path.join(target, directory), { recursive: true });
      copied += 1;
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      console.error(`previous web assets: skipped ${from}: ${error && error.message}`);
    }
  }
}
console.log(`previous web assets: copied ${copied} asset directories from ${source}`);
