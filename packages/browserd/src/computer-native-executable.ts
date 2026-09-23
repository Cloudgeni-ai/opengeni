import { constants } from "node:fs";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** ScreenCaptureKit can route concurrent helpers sharing an executable path to
 * the first process. Give each macOS helper its own byte-identical executable;
 * preserve the signature and the responsible application's permission boundary. */
export async function prepareComputerNativeExecutable(
  binaryPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ path: string; cleanup(): Promise<void> }> {
  if (platform !== "darwin") return { path: binaryPath, async cleanup() {} };
  const directory = await mkdtemp(join(tmpdir(), "opengeni-computer-native-"));
  const path = join(directory, basename(binaryPath));
  try {
    await chmod(directory, 0o700);
    await copyFile(binaryPath, path, constants.COPYFILE_FICLONE);
    await chmod(path, 0o700);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { path, cleanup: async () => await rm(directory, { recursive: true, force: true }) };
}
