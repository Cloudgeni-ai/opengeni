import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const declarationScript = fileURLToPath(new URL("./emit-declarations.ts", import.meta.url));

export async function emitDeclarationsOnSuccess(): Promise<void> {
  const child = spawn("bun", [declarationScript], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`stable TypeScript declaration emit exited on signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`stable TypeScript declaration emit failed with exit code ${exitCode}`);
  }
}
