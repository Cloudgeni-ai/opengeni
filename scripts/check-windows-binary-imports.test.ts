import { describe, expect, test } from "bun:test";
import { missingOnStockWindows, peImports } from "./check-windows-binary-imports";

/**
 * A minimal PE32+ image: one `.idata` section holding an import table and a
 * delay-load table, each naming the given DLLs.
 */
function syntheticPe(imports: string[], delayImports: string[]): Uint8Array {
  const bytes = new Uint8Array(0x1000);
  const view = new DataView(bytes.buffer);
  const pe = 0x80;
  const optional = pe + 24;
  const optionalSize = 240;
  const sectionTable = optional + optionalSize;
  const rawPointer = 0x400;
  const virtualAddress = 0x2000;

  view.setUint16(0, 0x5a4d, true);
  view.setUint32(0x3c, pe, true);
  view.setUint32(pe, 0x00004550, true);
  view.setUint16(pe + 4, 0x8664, true);
  view.setUint16(pe + 6, 1, true);
  view.setUint16(pe + 20, optionalSize, true);
  view.setUint16(optional, 0x20b, true);

  // .idata: import descriptors, then delay descriptors, then the names.
  view.setUint32(sectionTable + 8, 0x800, true);
  view.setUint32(sectionTable + 12, virtualAddress, true);
  view.setUint32(sectionTable + 16, 0x800, true);
  view.setUint32(sectionTable + 20, rawPointer, true);

  const importTable = 0;
  const delayTable = 0x100;
  let names = 0x200;
  const writeName = (name: string): number => {
    const rva = virtualAddress + names;
    bytes.set(new TextEncoder().encode(`${name}\0`), rawPointer + names);
    names += name.length + 1;
    return rva;
  };
  imports.forEach((dll, index) => {
    view.setUint32(rawPointer + importTable + index * 20 + 12, writeName(dll), true);
  });
  delayImports.forEach((dll, index) => {
    view.setUint32(rawPointer + delayTable + index * 32 + 4, writeName(dll), true);
  });
  const directories = optional + 112;
  view.setUint32(directories + 1 * 8, virtualAddress + importTable, true);
  if (delayImports.length > 0) {
    view.setUint32(directories + 13 * 8, virtualAddress + delayTable, true);
  }
  return bytes;
}

describe("Windows binary imports", () => {
  test("reads direct and delay-loaded DLL names", () => {
    const image = syntheticPe(["KERNEL32.dll", "VCRUNTIME140.dll"], ["USER32.dll"]);
    expect(peImports(image)).toEqual({
      imports: ["KERNEL32.dll", "VCRUNTIME140.dll"],
      delayImports: ["USER32.dll"],
    });
  });

  test("flags runtimes a stock Windows install lacks", () => {
    const image = syntheticPe(
      ["kernel32.dll", "api-ms-win-crt-runtime-l1-1-0.dll", "VCRUNTIME140.dll"],
      ["MSVCP140.dll", "ws2_32.dll"],
    );
    expect(missingOnStockWindows(peImports(image))).toEqual(["VCRUNTIME140.dll", "MSVCP140.dll"]);
  });

  test("accepts a binary that only uses Windows' own DLLs", () => {
    const image = syntheticPe(["kernel32.dll", "ucrtbase.dll", "bcrypt.dll"], []);
    expect(missingOnStockWindows(peImports(image))).toEqual([]);
  });

  test("rejects files that are not PE images", () => {
    expect(() => peImports(new Uint8Array(64))).toThrow("not a PE file");
  });
});
