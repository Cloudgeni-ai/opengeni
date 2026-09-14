import { expect, mock, test } from "bun:test";
import { SkillDiscovery } from "../src/skill-discovery";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const skill = {
  id: "example/skills/research",
  name: "Research",
  source: "example/skills",
  installs: 10,
  url: "https://skills.sh/example/skills/research",
};

test("empty search browses real agent skills without importing until a row is opened", async () => {
  const client = { searchPublicSkills: mock(async () => ({ items: [skill], nextCursor: null })) };
  const onImport = mock(() => {});
  const props = { client, workspaceId: "workspace", query: "", canManage: true, onImport };
  const view = await renderComponent(<SkillDiscovery {...props} />);
  try {
    await flush(350);
    expect(client.searchPublicSkills).toHaveBeenCalledWith("workspace", "agent");
    const row = view.container.querySelector<HTMLButtonElement>(".og-capability-catalog-row")!;
    expect(row.textContent).toContain("Research");
    expect(row.querySelector(".lucide-book-open")).not.toBeNull();
    expect(onImport).not.toHaveBeenCalled();
    await actRun(() => row.click());
    expect(onImport).toHaveBeenCalledWith(skill.url);
    await view.rerender(<SkillDiscovery {...props} query="design" />);
    await flush(350);
    expect(client.searchPublicSkills).toHaveBeenLastCalledWith("workspace", "design");
    await view.rerender(<SkillDiscovery {...props} query="d" />);
    await flush(350);
    expect(client.searchPublicSkills).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain("at least two characters");
    expect(view.container.querySelector(".og-capability-catalog-row")).toBeNull();
  } finally {
    await view.unmount();
  }
});

test("overview combines installed and public skills within six results and opens the full category", async () => {
  const client = {
    searchPublicSkills: mock(async () => ({
      items: Array.from({ length: 10 }, (_, i) => ({
        ...skill,
        id: String(i),
        name: `Public ${i}`,
      })),
      nextCursor: null,
    })),
  };
  const more = mock(() => {});
  const view = await renderComponent(
    <SkillDiscovery
      client={client}
      workspaceId="overview"
      query="agent"
      canManage
      onImport={() => {}}
      resultLimit={6}
      onShowMore={more}
      localSkills={[{ id: "local", name: "My skill", onOpen: () => {} }]}
    />,
  );
  try {
    await flush(350);
    expect(view.container.querySelectorAll(".og-capability-catalog-row")).toHaveLength(6);
    expect(view.container.textContent).toContain("My skill");
    expect(view.container.querySelector("h3")?.textContent).toBe("Skills");
    const button = [...view.container.querySelectorAll("button")].find(
      (node) => node.textContent === "View all skills",
    )!;
    await actRun(() => button.click());
    expect(more).toHaveBeenCalledTimes(1);
  } finally {
    await view.unmount();
  }
});

test("returning to Skills reuses discovery without loading and keeps installed state fresh", async () => {
  const client = { searchPublicSkills: mock(async () => ({ items: [skill], nextCursor: null })) };
  const props = { client, workspaceId: "cached", query: "", canManage: true, onImport: () => {} };
  const first = await renderComponent(<SkillDiscovery {...props} />);
  await flush(350);
  await first.unmount();
  const second = await renderComponent(
    <SkillDiscovery
      {...props}
      installedSkills={[
        {
          name: skill.name,
          sourceUrl: skill.url,
          repositoryUrl: "https://github.com/example/skills",
        },
      ]}
    />,
  );
  try {
    expect(second.container.textContent).not.toContain("Loading skills");
    expect(second.container.querySelector('[data-status="added"]')).not.toBeNull();
    await flush(350);
    expect(client.searchPublicSkills).toHaveBeenCalledTimes(1);
    await second.rerender(<SkillDiscovery {...props} workspaceId="another" />);
    await flush(350);
    expect(client.searchPublicSkills).toHaveBeenCalledTimes(2);
    const otherClient = {
      searchPublicSkills: mock(async () => ({ items: [skill], nextCursor: null })),
    };
    await second.rerender(<SkillDiscovery {...props} client={otherClient} />);
    await flush(350);
    expect(otherClient.searchPublicSkills).toHaveBeenCalledTimes(1);
  } finally {
    await second.unmount();
  }
});

test("concurrent skill discovery views share the pending request", async () => {
  let resolve!: (page: { items: (typeof skill)[]; nextCursor: null }) => void;
  const client = {
    searchPublicSkills: mock(
      () =>
        new Promise<{ items: (typeof skill)[]; nextCursor: null }>((done) => {
          resolve = done;
        }),
    ),
  };
  const props = {
    client,
    workspaceId: "pending",
    query: "research",
    canManage: true,
    onImport: () => {},
  };
  const first = await renderComponent(<SkillDiscovery {...props} />);
  const second = await renderComponent(<SkillDiscovery {...props} />);
  try {
    await flush(350);
    expect(client.searchPublicSkills).toHaveBeenCalledTimes(1);
    await actRun(() => resolve({ items: [skill], nextCursor: null }));
    await flush(10);
    expect(first.container.querySelectorAll(".og-capability-catalog-row")).toHaveLength(1);
    expect(second.container.querySelectorAll(".og-capability-catalog-row")).toHaveLength(1);
  } finally {
    await first.unmount();
    await second.unmount();
  }
});
