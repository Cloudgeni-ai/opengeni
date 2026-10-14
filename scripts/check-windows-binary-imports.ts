#!/usr/bin/env bun
// Fails when a Windows executable or native module we ship needs a DLL that a
// stock Windows install does not have. The Visual C++ runtime is the usual one:
// a binary linked against it starts on CI runners (which have it) and then
// exits with "DLL not found" on an ordinary PC.
//
//   bun scripts/check-windows-binary-imports.ts <file.exe|file.node|file.dll>...

import { readFileSync } from "node:fs";

/** Redistributable runtimes that are not part of Windows itself. */
const NOT_ON_STOCK_WINDOWS =
  /^(vcruntime\d|msvcp\d|vccorlib\d|concrt\d|vcomp\d|vcamp\d|mfc\d|atl\d|ucrtbased\.dll$|msvcr\d)/iu;

export interface PeImports {
  imports: string[];
  delayImports: string[];
}

/** The DLL names a PE file imports, directly and delay-loaded. */
export function peImports(bytes: Uint8Array): PeImports {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0x5a4d) throw new Error("not a PE file (no MZ header)");
  const pe = view.getUint32(0x3c, true);
  if (view.getUint32(pe, true) !== 0x00004550) throw new Error("not a PE file (no PE signature)");
  const sections = view.getUint16(pe + 6, true);
  const optionalSize = view.getUint16(pe + 20, true);
  const optional = pe + 24;
  const magic = view.getUint16(optional, true);
  const directories = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : NaN);
  if (Number.isNaN(directories)) throw new Error("unknown PE optional header");
  const sectionTable = optional + optionalSize;

  const offsetOf = (rva: number): number => {
    for (let index = 0; index < sections; index += 1) {
      const header = sectionTable + index * 40;
      const virtualSize = view.getUint32(header + 8, true);
      const virtualAddress = view.getUint32(header + 12, true);
      const rawSize = view.getUint32(header + 16, true);
      const rawPointer = view.getUint32(header + 20, true);
      if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
        return rva - virtualAddress + rawPointer;
      }
    }
    throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
  };
  const name = (rva: number): string => {
    const start = offsetOf(rva);
    let end = start;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    return new TextDecoder("ascii").decode(bytes.subarray(start, end));
  };
  const table = (directory: number, entrySize: number, nameField: number): string[] => {
    const rva = view.getUint32(directories + directory * 8, true);
    if (rva === 0) return [];
    const names: string[] = [];
    for (let entry = offsetOf(rva); ; entry += entrySize) {
      const nameRva = view.getUint32(entry + nameField, true);
      if (nameRva === 0) break;
      names.push(name(nameRva));
    }
    return names;
  };
  return {
    // IMAGE_IMPORT_DESCRIPTOR: 20 bytes, Name at 12.
    imports: table(1, 20, 12),
    // IMAGE_DELAYLOAD_DESCRIPTOR: 32 bytes, DllNameRVA at 4.
    delayImports: table(13, 32, 4),
  };
}

/** Imported DLLs a stock Windows install lacks. */
export function missingOnStockWindows(imports: PeImports): string[] {
  return [...imports.imports, ...imports.delayImports].filter((dll) =>
    NOT_ON_STOCK_WINDOWS.test(dll),
  );
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: check-windows-binary-imports.ts <file>...");
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    const imports = peImports(readFileSync(file));
    const missing = missingOnStockWindows(imports);
    if (missing.length > 0) {
      failed = true;
      console.error(`${file}: needs ${missing.join(", ")}, which stock Windows does not ship`);
    } else {
      console.log(`${file}: ok (${imports.imports.length + imports.delayImports.length} DLLs)`);
    }
  }
  if (failed) process.exit(1);
}
