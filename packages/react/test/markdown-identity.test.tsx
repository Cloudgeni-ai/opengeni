import { expect, test } from "bun:test";
import { useEffect } from "react";
import { Markdown } from "../src/components/markdown";
import { actRun, registerDom, renderComponent } from "./render-hook";

registerDom();

test("host callback updates preserve paragraphs, selections, and media while using fresh handlers", async () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const source = `Verified again:\n\n- Tests passed\n\nThe blocker is an unrelated **accessibility failure** on the invitation page.\n\n[Artifact](artifact:${id}) [File](sandbox:/workspace/report.txt)\n\n![Video](artifact:${id})`;
  let mounts = 0;
  let unmounts = 0;
  const opened: number[] = [];
  function Player() {
    useEffect(() => {
      mounts++;
      return () => {
        unmounts++;
      };
    }, []);
    return <video src="/example.mp4" controls />;
  }
  const view = (revision: number) => (
    <Markdown
      artifactHref={(value) => `/revision-${revision}/${value}`}
      onSandboxFile={() => {
        opened.push(revision);
      }}
      renderImage={() => <Player />}
    >
      {source}
    </Markdown>
  );
  const r = await renderComponent(view(0));
  try {
    const paragraph = r.container.querySelectorAll("p")[1]!;
    const video = r.container.querySelector("video")!;
    const link = r.container.querySelector("a")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const selected = selection.toString();
    for (let revision = 1; revision <= 5; revision++) {
      await r.rerender(view(revision));
      expect(r.container.querySelectorAll("p")[1]).toBe(paragraph);
      expect(r.container.querySelector("video")).toBe(video);
      expect(r.container.querySelector("a")).toBe(link);
      expect(selection.toString()).toBe(selected);
      expect(link.getAttribute("href")).toBe(`/revision-${revision}/${id}`);
    }
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
    await actRun(() => r.container.querySelector("button")!.click());
    expect(opened).toEqual([5]);
  } finally {
    await r.unmount();
  }
  expect(unmounts).toBe(1);
});
