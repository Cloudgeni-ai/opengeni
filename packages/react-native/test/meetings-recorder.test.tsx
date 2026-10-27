import { describe, expect, mock, test } from "bun:test";
import { act, useEffect, useMemo, useState, type ReactNode } from "react";
import { registerDom, renderComponent } from "../../react/test/render-hook";

registerDom();

// The capture platform and the recorder hook are replaced: these tests are about
// how the provider holds a recorder, not about recording.
const started: string[] = [];
const stopped: string[] = [];
const setStates = new Map<string, (state: string) => void>();
mock.module("../src/recordings", () => ({
  useNativeRecorderPlatform: (options: { storeScope?: string }) => ({
    scope: options.storeScope ?? "",
  }),
}));
mock.module("@opengeni/react/recordings", () => ({
  useRecorder: (options: { workspaceId?: string; platform: { scope: string } }) => {
    const id = `${options.platform.scope}/${options.workspaceId ?? ""}`;
    const [state, setState] = useState("idle");
    const recorder = useMemo(() => ({ state, recordingId: null, id }), [state, id]);
    useEffect(() => {
      setStates.set(id, setState);
      started.push(id);
      return () => void stopped.push(id);
    }, [id]);
    return recorder;
  },
}));

const { MeetingRecorderProvider, useMeetingRecorder } = await import("../src/meetings/recorder");

let mounts = 0;
let seen: unknown[] = [];
function Screen() {
  useEffect(() => {
    mounts += 1;
  }, []);
  const recorder = useMeetingRecorder() as { id?: string } | null;
  seen.push(recorder?.id ?? null);
  return null;
}

function tree(props: { storeScope?: string; workspaceId: string | null }): ReactNode {
  return (
    <MeetingRecorderProvider client={{}} {...props}>
      <Screen />
    </MeetingRecorderProvider>
  );
}

describe("MeetingRecorderProvider", () => {
  test("a new account gets a fresh recorder while the screens below stay mounted", async () => {
    mounts = 0;
    seen = [];
    const rendered = await renderComponent(tree({ storeScope: "a", workspaceId: "w1" }));
    expect(seen.at(-1)).toBe("a/w1");

    await rendered.rerender(tree({ storeScope: "b", workspaceId: "w2" }));
    // The old recorder stopped, the new one is what the screens read, and the
    // screens were never remounted.
    expect(stopped).toContain("a/w1");
    expect(started).toContain("b/w2");
    expect(seen.at(-1)).toBe("b/w2");
    expect(mounts).toBe(1);
    await rendered.unmount();
  });

  test("no recorder until the workspace is known", async () => {
    seen = [];
    const rendered = await renderComponent(tree({ storeScope: "a", workspaceId: null }));
    expect(seen.at(-1)).toBeNull();
    await rendered.rerender(tree({ storeScope: "a", workspaceId: "w1" }));
    expect(seen.at(-1)).toBe("a/w1");
    await rendered.unmount();
  });

  test("a recording keeps going in its workspace when another is chosen, then the recorder follows", async () => {
    seen = [];
    stopped.length = 0;
    const rendered = await renderComponent(tree({ storeScope: "a", workspaceId: "w1" }));
    await act(async () => setStates.get("a/w1")!("recording"));

    await rendered.rerender(tree({ storeScope: "a", workspaceId: "w2" }));
    expect(stopped).not.toContain("a/w1");
    expect(seen.at(-1)).toBe("a/w1");

    await act(async () => setStates.get("a/w1")!("stopped"));
    expect(stopped).toContain("a/w1");
    expect(seen.at(-1)).toBe("a/w2");
    await rendered.unmount();
  });

  test("a new account still ends a recording at once", async () => {
    stopped.length = 0;
    const rendered = await renderComponent(tree({ storeScope: "a", workspaceId: "w1" }));
    await act(async () => setStates.get("a/w1")!("recording"));
    await rendered.rerender(tree({ storeScope: "b", workspaceId: "w1" }));
    expect(stopped).toContain("a/w1");
    expect(seen.at(-1)).toBe("b/w1");
    await rendered.unmount();
  });

  test("outside a provider there is no recorder", async () => {
    seen = [];
    const rendered = await renderComponent(<Screen />);
    expect(seen.at(-1)).toBeNull();
    await rendered.unmount();
  });
});
