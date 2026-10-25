import { expect, test } from "bun:test";
import { InteractionDefiniteDriverError } from "@opengeni/interaction";
import { scrollRefusal } from "../src/cdp-driver";

test("a refused scroll is a definite refusal named by the browser's reply", () => {
  const refusal = (message: string) => {
    const error = scrollRefusal(message);
    return error === null
      ? null
      : {
          definite: error instanceof InteractionDefiniteDriverError,
          code: error.code,
          message: error.message,
        };
  };
  // An element removed from the page is stale, not unrendered.
  for (const message of ["No node with given id found", "Node is detached from document"])
    expect(refusal(message)).toEqual({
      definite: true,
      code: "locator_not_found",
      message: "browser element is no longer present",
    });
  expect(refusal("Node does not have a layout object")).toEqual({
    definite: true,
    code: "invalid_action",
    message: "browser element has no box on the page to act on; it is hidden or not rendered",
  });
  // Any other reply is left to the general classification.
  expect(refusal("Internal error")).toBeNull();
});
