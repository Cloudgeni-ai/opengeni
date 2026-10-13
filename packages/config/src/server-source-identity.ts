import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Image-owned source identity for native qualification. Deployment telemetry,
 * environment variables and caller metadata never replace these baked bytes. */
export async function readImmutableServerSourceSha(): Promise<string | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open("/opt/opengeni/source-sha", constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat();
    if (!before.isFile() || before.uid !== 0 || (before.mode & 0o222) !== 0 || before.size !== 40)
      return undefined;
    const bytes = Buffer.alloc(41);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (
      bytesRead !== 40 ||
      after.size !== 40 ||
      after.uid !== 0 ||
      (after.mode & 0o222) !== 0 ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      return undefined;
    const sha = bytes.subarray(0, bytesRead).toString("utf8");
    return /^[0-9a-f]{40}$/u.test(sha) ? sha : undefined;
  } catch {
    // Local development and an old image are unqualified, not substitute sources.
    return undefined;
  } finally {
    try {
      await file?.close();
    } catch {
      // Best-effort descriptor cleanup after source observation.
    }
  }
}
