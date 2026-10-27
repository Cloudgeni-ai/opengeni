// Who the recorder belongs to: a moment of not knowing (a reconnect, an
// update, a sign-in being read again) must not end a recording, but a real
// sign-out or another person must.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const { useRecorderPerson } = await import("./recorder-provider");

describe("The recorder's person", () => {
  test("keeps the last person known while it is read again, and follows real changes", async () => {
    const seen: (string | null)[] = [];
    function Probe({ person }: { person: string | null | undefined }) {
      seen.push(useRecorderPerson(person));
      return null;
    }
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const render = (person: string | null | undefined) =>
      act(async () => root.render(<Probe person={person} />));
    const now = () => seen.at(-1);
    try {
      await render(undefined);
      expect(now()).toBeNull();
      await render("person-1");
      expect(now()).toBe("person-1");
      await render(undefined);
      expect(now()).toBe("person-1");
      await render("person-2");
      expect(now()).toBe("person-2");
      await render(null);
      expect(now()).toBeNull();
      await render(undefined);
      expect(now()).toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
