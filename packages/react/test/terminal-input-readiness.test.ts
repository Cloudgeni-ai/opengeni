import { describe, expect, test } from "bun:test";
import { terminalInputReadyDecoder } from "../src/lib/terminal-input-readiness";

const id = "0123456789abcdef0123456789abcdef";
const other = "abcdef0123456789abcdef0123456789";
const hello = `\x1b]777;opengeni-input;hello;${id}\x07`;
const ready = `\x1b]777;opengeni-input;ready;${id}\x07`;

describe("connection-bound readiness metadata", () => {
  test("every split retains only metadata and emits readiness exactly once", () => {
    const stream = `banner${hello}prompt${ready}tail`;
    for (let split = 0; split <= stream.length; split++) {
      const decode = terminalInputReadyDecoder();
      const first = decode(stream.slice(0, split));
      const second = decode(stream.slice(split));
      expect(first.output + second.output).toBe("bannerprompttail");
      expect(Number(first.ready) + Number(second.ready)).toBe(1);
      expect(decode(hello + ready)).toEqual({ output: "", ready: false });
    }
  });
  test("unsolicited, mismatched and previous-generation READY cannot open input", () => {
    const decode = terminalInputReadyDecoder();
    expect(decode(ready).ready).toBe(false);
    expect(decode(hello + `\x1b]777;opengeni-input;ready;${other}\x07`).ready).toBe(false);
    expect(decode(`\x1b]777;opengeni-input;hello;${other}\x07`).ready).toBe(false);
    expect(decode(ready).ready).toBe(true);
    expect(terminalInputReadyDecoder()(ready).ready).toBe(false);
  });
  test("malformed and oversized frames pass through without unbounded buffering", () => {
    const decode = terminalInputReadyDecoder();
    for (const input of [
      "normal output",
      "\x1b]777;opengeni-input;ready;bad\x07",
      "\x1b]777;opengeni-input;" + "x".repeat(100_000),
    ]) {
      expect(decode(input)).toEqual({ output: input, ready: false });
    }
    expect(decode(hello + ready)).toEqual({ output: "", ready: true });
  });
});
