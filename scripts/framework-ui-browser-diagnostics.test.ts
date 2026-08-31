import { expect, test } from "bun:test";

import { isExpectedFirefoxWebGLUnavailableWarning } from "./framework-ui-browser-diagnostics";

const firefoxRunnerWarning = `console.warning: [JavaScript Warning: "Failed to create WebGL context: WebGL creation failed:
* AllowWebgl2:false restricts context creation on this system. ()" {file: "http://127.0.0.1:22851/@fs/home/runner/work/opengeni/opengeni/packages/react/node_modules/.vite/deps/@xterm_addon-webgl.js?v=1ec97786" line: 4406}]`;

test("classifies only the exact Firefox xterm runner-policy WebGL warning", () => {
  expect(isExpectedFirefoxWebGLUnavailableWarning(firefoxRunnerWarning)).toBe(true);
  expect(
    isExpectedFirefoxWebGLUnavailableWarning(
      firefoxRunnerWarning.replace("@xterm_addon-webgl.js", "host-application.js"),
    ),
  ).toBe(false);
  expect(
    isExpectedFirefoxWebGLUnavailableWarning(
      firefoxRunnerWarning.replace("AllowWebgl2:false", "AllowWebgl2:true"),
    ),
  ).toBe(false);
  expect(
    isExpectedFirefoxWebGLUnavailableWarning(
      firefoxRunnerWarning.replace("console.warning:", "console.error:"),
    ),
  ).toBe(false);
});
