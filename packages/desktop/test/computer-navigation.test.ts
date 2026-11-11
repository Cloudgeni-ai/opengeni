import { expect, test, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { computerConnectUrl } from "@opengeni/sdk/app-links";
import { electronStub } from "./electron-stub";

mock.module("electron", () => electronStub);
const { MainWindow } = await import("../src/main/window");

function fixture() {
  const links: string[] = [];
  const external: string[] = [];
  const window = Object.create(MainWindow.prototype) as any;
  window.config = { scheme: "opengeni", productName: "Test", background: {} };
  window.events = { connectComputer: (url: string) => links.push(url) };
  electronStub.shell.openExternal = async (url: string) => {
    external.push(url);
  };
  const contents = new EventEmitter() as any;
  contents.setWindowOpenHandler = (handler: unknown) => {
    contents.openWindow = handler;
  };
  window.guardNavigation(contents, "https://app.example");
  return { links, external, contents };
}
const link = computerConnectUrl({
  webUrl: "https://app.example/workspaces/w1/sessions/s1",
  subjectId: "person",
});

test("account page connection links reach the desktop handler from navigation and new windows", () => {
  const { links, external, contents } = fixture();
  for (const event of ["will-navigate", "will-redirect"]) {
    const preventDefault = mock(() => {});
    contents.emit(event, { preventDefault }, link);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  }
  expect(contents.openWindow({ url: link })).toEqual({ action: "deny" });
  expect(links).toEqual([link, link, link]);
  expect(external).toEqual([]);
});

test("malformed, cross-server and unrelated custom links never dispatch or reach the OS", () => {
  const { links, external, contents } = fixture();
  for (const url of [
    "opengeni://connect",
    "other://connect",
    "opengeni://auth?code=untrusted",
    computerConnectUrl({ webUrl: "https://other.example/workspaces/w1", subjectId: "person" }),
  ]) {
    contents.emit("will-navigate", { preventDefault() {} }, url);
  }
  expect(links).toEqual([]);
  expect(external).toEqual([]);
  contents.emit("will-navigate", { preventDefault() {} }, "https://docs.example");
  expect(external).toEqual(["https://docs.example/"]);
});
