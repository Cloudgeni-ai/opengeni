import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { NativeRelaySignIn } from "./native-sign-in";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    // happy-dom's input events don't reach React's change tracking.
    const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"))!;
    const props = (input as unknown as Record<string, { onChange(event: unknown): void }>)[
      propsKey
    ]!;
    props.onChange({ target: input });
  });
}

test("a relayed sign-in is allowed only with the code shown in Excel", async () => {
  const approvals: { relayId: string; confirmationCode: string }[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <NativeRelaySignIn
        search={{ platform: "office", device_name: "Bendik's work laptop", relay: "r".repeat(43) }}
        relayId={"r".repeat(43)}
        email="ada@example.test"
        approve={async (input) => {
          approvals.push(input);
        }}
        signOut={async () => {}}
      />,
    ),
  );
  const submit = () =>
    [...container.querySelectorAll("button")].find((button) => button.type === "submit")!;
  expect(container.textContent).toContain("Code shown in Excel");
  // The device row is fixed for the platform, never the link's own text.
  expect(container.textContent).toContain("the Opengeni add-in in Excel");
  expect(submit().disabled).toBe(true);

  expect(container.textContent).not.toContain("work laptop");
  await type(container.querySelector("input")!, "ab3x7k");
  expect(submit().disabled).toBe(false);
  await act(async () => {
    submit().click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(approvals).toEqual([{ relayId: "r".repeat(43), confirmationCode: "ab3x7k" }]);
  expect(container.textContent).toContain("You're signed in to the add-in");
  await act(async () => root.unmount());
});
