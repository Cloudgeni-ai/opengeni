import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thinMacNativeAsset } from "../scripts/stage-cua-runtime";

// Real Mach-O headers and real lipo: also runnable on Linux with LLVM's lipo.
// No native code is executed by these fixtures.
function thinFixture(architecture: "x64" | "arm64") {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(architecture === "x64" ? 0x01000007 : 0x0100000c, 4);
  bytes.writeUInt32LE(architecture === "x64" ? 3 : 0, 8);
  bytes.writeUInt32LE(1, 12); // MH_OBJECT, with no sections or load commands
  return bytes;
}

for (const architecture of ["x64", "arm64"] as const) {
  test.skipIf(process.platform !== "darwin" && !Bun.which("lipo"))(
    `CUA native assets retain only ${architecture}`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "cua-native-slices-"));
      try {
        const x64 = join(root, "x64.dylib");
        const arm64 = join(root, "arm64.dylib");
        const universal = join(root, "universal.node");
        await writeFile(x64, thinFixture("x64"));
        await writeFile(arm64, thinFixture("arm64"));
        const child = Bun.spawn(["lipo", "-create", x64, arm64, "-output", universal]);
        expect(await child.exited).toBe(0);
        const before = await readFile(universal);
        await thinMacNativeAsset(universal, architecture);
        const after = await readFile(universal);
        expect(after).toEqual(thinFixture(architecture));
        expect(after.length).toBeLessThan(before.length);
        // Already-thin upstream assets work too, without changing their bytes.
        await thinMacNativeAsset(universal, architecture);
        expect(await readFile(universal)).toEqual(after);
        expect(await readFile(x64)).toEqual(thinFixture("x64"));
        expect(await readFile(arm64)).toEqual(thinFixture("arm64"));
        await expect(
          thinMacNativeAsset(universal, architecture === "x64" ? "arm64" : "x64"),
        ).rejects.toThrow("does not contain required architecture");
        expect(await readFile(universal)).toEqual(after);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

test("CUA native asset thinning rejects unsupported architectures", async () => {
  await expect(thinMacNativeAsset("unused", "ia32")).rejects.toThrow(
    "Unsupported macOS CUA architecture",
  );
});
