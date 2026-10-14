// Manual fixture retention only. Tests import the retained bytes, never run Git.
import { createHash } from "node:crypto";

const revision = "e080c19084e87f07d481e92fd7b4ae8b671d01af";
const path = "packages/sdk/src/site-browser-runtime.gen.ts";
const expected = "0db71e767389ee86cefb77823d17976d4f14f2322900e7cd72d3ada2fba057f3";
const result = Bun.spawnSync(["git", "show", `${revision}:${path}`]);
if (result.exitCode !== 0) throw new Error("Historical Site runtime is unavailable");
if (createHash("sha256").update(result.stdout).digest("hex") !== expected)
  throw new Error("Historical Site runtime hash mismatch");
await Bun.write(new URL("./site-browser-runtime.e080c190.txt", import.meta.url), result.stdout);
