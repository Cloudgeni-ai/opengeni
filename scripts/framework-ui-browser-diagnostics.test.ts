import { expect, test } from "bun:test";

import {
  isExpectedFirefoxHarnessWarning,
  isExpectedFirefoxWebGLUnavailableWarning,
  isExpectedReducedMotionWarning,
} from "./framework-ui-browser-diagnostics";

const reducedMotionWarning =
  "console.warning: You have Reduced Motion enabled on your device. Animations may not appear as expected.. For more information and steps for solving, visit https://motion.dev/troubleshooting/reduced-motion-disabled";
const firefoxHarnessWarning =
  'console.warning: [JavaScript Warning: "Layout was forced before the page was fully loaded. If stylesheets are not yet loaded this may cause a flash of unstyled content." {file: "chrome://juggler/content/content/main.js" line: 1}]';

const firefoxRunnerWarning = `console.warning: [JavaScript Warning: "Failed to create WebGL context: WebGL creation failed:
* AllowWebgl2:false restricts context creation on this system. ()" {file: "http://127.0.0.1:22851/@fs/home/runner/work/opengeni/opengeni/packages/react/node_modules/.vite/deps/@xterm_addon-webgl.js?v=1ec97786" line: 4406}]`;

test("classifies only the exact reduced-motion warning", () => {
  expect(isExpectedReducedMotionWarning(reducedMotionWarning)).toBe(true);
  expect(isExpectedReducedMotionWarning(`prefix ${reducedMotionWarning}`)).toBe(false);
  expect(isExpectedReducedMotionWarning(`${reducedMotionWarning} product failed`)).toBe(false);
  expect(isExpectedReducedMotionWarning(reducedMotionWarning.replace("warning", "error"))).toBe(
    false,
  );
});

test("classifies only the exact Firefox harness warning", () => {
  expect(isExpectedFirefoxHarnessWarning(firefoxHarnessWarning)).toBe(true);
  expect(isExpectedFirefoxHarnessWarning(`prefix ${firefoxHarnessWarning}`)).toBe(false);
  expect(isExpectedFirefoxHarnessWarning(`${firefoxHarnessWarning} product failed`)).toBe(false);
  expect(isExpectedFirefoxHarnessWarning(firefoxHarnessWarning.replace("warning", "error"))).toBe(
    false,
  );
  expect(
    isExpectedFirefoxHarnessWarning(
      firefoxHarnessWarning.replace(
        "chrome://juggler/content/content/main.js",
        "http://127.0.0.1/product.js",
      ),
    ),
  ).toBe(false);
  expect(isExpectedFirefoxHarnessWarning(firefoxHarnessWarning.replace("line: 1", "line: 0"))).toBe(
    false,
  );
});

test("classifies only the exact Firefox xterm runner-policy WebGL warning", () => {
  expect(isExpectedFirefoxWebGLUnavailableWarning(firefoxRunnerWarning)).toBe(true);
  expect(
    isExpectedFirefoxWebGLUnavailableWarning(
      firefoxRunnerWarning.replace("WebGL creation failed:\n", "WebGL creation failed: \n"),
    ),
  ).toBe(true);
  expect(
    isExpectedFirefoxWebGLUnavailableWarning(
      firefoxRunnerWarning.replace("WebGL creation failed:\n", "WebGL creation failed:  \n"),
    ),
  ).toBe(false);
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
  expect(isExpectedFirefoxWebGLUnavailableWarning(`${firefoxRunnerWarning}\nproduct failed`)).toBe(
    false,
  );
  expect(isExpectedFirefoxWebGLUnavailableWarning(`${firefoxRunnerWarning} suffix`)).toBe(false);
  expect(
    isExpectedFirefoxWebGLUnavailableWarning(
      firefoxRunnerWarning.replace(
        "/@xterm_addon-webgl.js?v=1ec97786",
        "/host-@xterm_addon-webgl.js?v=1ec97786",
      ),
    ),
  ).toBe(false);
  expect(
    isExpectedFirefoxWebGLUnavailableWarning(
      firefoxRunnerWarning.replace("?v=1ec97786", "?v=1ec97786&source=product"),
    ),
  ).toBe(false);
});
