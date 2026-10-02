import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Compiled Bun cannot resolve CUA's native packages inside its virtual FS.
 * Releases carry the unmodified SDK bundle and native assets in the same
 * immutable helper generation. No ambient package lookup or runtime download. */
export async function loadCuaDriver(): Promise<typeof import("@trycua/cua-driver").CuaDriver> {
  if (!/^(?:\/\$bunfs\/|B:[\\/]~BUN[\\/])/i.test(import.meta.path)) {
    return (await import("@trycua/cua-driver")).CuaDriver;
  }
  const path = join(dirname(process.execPath), "cua-sdk", "index.js");
  if (!(await Bun.file(path).exists())) {
    throw new Error("This interaction runtime does not contain the experimental CUA SDK");
  }
  const sdk = (await import(pathToFileURL(path).href)) as typeof import("@trycua/cua-driver");
  if (typeof sdk.CuaDriver?.create !== "function") throw new Error("Invalid packaged CUA SDK");
  return sdk.CuaDriver;
}
