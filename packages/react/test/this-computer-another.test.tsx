import { expect, test } from "bun:test";
import { act } from "react";
import { registerDom, renderComponent } from "./render-hook";
import { ThisComputerCard } from "../src/this-computer";

registerDom();

const ready = [
  {
    sandboxId: "pc",
    enrollmentId: "enr-pc",
    name: "Studio desktop",
    scope: "user",
    state: "online",
  },
] as never;

function anotherButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Connect another computer",
  );
  if (!button) throw new Error("missing Connect another computer");
  return button;
}

function controlled(container: HTMLElement, button: HTMLButtonElement): HTMLElement {
  const id = button.getAttribute("aria-controls");
  const steps = [...container.querySelectorAll<HTMLElement>("[id]")].find((node) => node.id === id);
  if (!steps) throw new Error("missing the steps the button controls");
  return steps;
}

test("connecting another computer opens in place and keeps focus on its button", async () => {
  const r = await renderComponent(
    <ThisComputerCard
      productName="Acme"
      machines={ready}
      downloads={[{ label: "Download Acme", url: "https://example.com/app" }]}
      openAppUrl="acme://connect"
    />,
  );
  const button = anotherButton(r.container);
  const steps = controlled(r.container, button);
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(steps.hidden).toBe(true);

  button.focus();
  await act(async () => button.click());

  // The same button stays mounted and focused; the steps it controls open.
  expect(anotherButton(r.container)).toBe(button);
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(steps.hidden).toBe(false);
  // The steps happen on the other computer; this device's links say who
  // they're for.
  expect(steps.textContent).toContain("Do this on the computer you want to connect");
  expect(steps.textContent).toContain("If it's this computer:");
  expect(steps.textContent).toContain("Download Acme");
  expect(steps.textContent).toContain("Open app and connect");

  await act(async () => button.click());
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(steps.hidden).toBe(true);
  await r.unmount();
});

test("with only a download page, the steps still happen on the other computer", async () => {
  const r = await renderComponent(
    <ThisComputerCard productName="Acme" machines={ready} downloadUrl="https://example.com/get" />,
  );
  const button = anotherButton(r.container);
  await act(async () => button.click());
  const steps = controlled(r.container, button);
  expect(steps.textContent).toContain(
    "Do this on the computer you want to connect: open this chat there, install the Acme app",
  );
  expect(steps.textContent).not.toContain("Install the Acme app on your computer");
  expect(steps.querySelector('a[href="https://example.com/get"]')?.textContent).toContain(
    "Get Acme for desktop",
  );
  await r.unmount();
});

test("connecting this device beside a ready computer elsewhere reports this device once it is ready", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
  const mini = { ...(ready as unknown as object[])[0], name: "Mac mini", os: "macos" };
  const pc = { ...mini, sandboxId: "win", enrollmentId: "enr-win", name: "Desk PC", os: "windows" };
  const readied: string[] = [];
  const render = (machines: object[]) => (
    <ThisComputerCard
      productName="Acme"
      machines={machines as never}
      onConnect={async () => {}}
      onReady={(name) => readied.push(name)}
    />
  );
  const r = await renderComponent(render([mini]));
  try {
    expect(r.container.textContent).toContain("Mac mini is another computer, not this one.");
    const button = [...r.container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Use this computer",
    )!;
    await act(async () => button.click());
    expect(readied).toEqual([]);

    await r.rerender(render([mini, pc]));
    expect(r.container.textContent).toContain("Agents can use Desk PC");
    expect(r.container.textContent).not.toContain("another computer, not this one");
    expect(readied).toEqual(["Desk PC"]);
  } finally {
    await r.unmount();
    if (original) Object.defineProperty(globalThis, "navigator", original);
  }
});
