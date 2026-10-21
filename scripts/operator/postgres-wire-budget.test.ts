import { expect, test } from "bun:test";
import { postgresWireBudget } from "./postgres-wire-budget";

test("counts simple, describe and extended cycles across fragmented/coalesced frames", () => {
  const boundaries: string[] = [];
  const read = postgresWireBudget((type) => boundaries.push(type));
  const startup = Buffer.from([0, 0, 0, 8, 0, 3, 0, 0]);
  const frame = (type: string, payload = "") => {
    const header = Buffer.alloc(5);
    header[0] = type.charCodeAt(0);
    header.writeInt32BE(4 + Buffer.byteLength(payload), 1);
    return Buffer.concat([header, Buffer.from(payload)]);
  };
  const bytes = Buffer.concat([
    startup,
    frame("Q", "begin\0"),
    frame("P", "query"),
    frame("D"),
    frame("H"),
    frame("B", "parameter"),
    frame("E"),
    frame("S"),
    frame("Q", "commit\0"),
  ]);
  for (let offset = 0; offset < bytes.length; offset += 3) read(bytes.subarray(offset, offset + 3));
  expect(boundaries).toEqual(["Q", "H", "S", "Q"]);
  read(Buffer.concat([frame("B", "value"), frame("E"), frame("S"), frame("X")]));
  expect(boundaries).toEqual(["Q", "H", "S", "Q", "S"]);
});
