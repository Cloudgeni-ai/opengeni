import { expect, mock, test } from "bun:test";
import { PluginDiscovery } from "../src/plugin-discovery";
import { flush, registerDom, renderComponent } from "./render-hook";
registerDom();
test("returning to plugin discovery reuses results without a loading screen, scoped to workspace", async () => {
  const client = { discoverPlugins: mock(async () => ({ items: [], total: 0, nextOffset: null })) };
  const props = { client, workspaceId: "one", query: "", onOpen: () => {} };
  const first = await renderComponent(<PluginDiscovery {...props} />);
  await flush(250);
  expect(client.discoverPlugins).toHaveBeenCalledTimes(1);
  await first.unmount();
  const second = await renderComponent(<PluginDiscovery {...props} />);
  try {
    expect(second.container.textContent).not.toContain("Loading plugins");
    await flush(250);
    expect(client.discoverPlugins).toHaveBeenCalledTimes(1);
    await second.rerender(<PluginDiscovery {...props} workspaceId="two" />);
    await flush(250);
    expect(client.discoverPlugins).toHaveBeenCalledTimes(2);
  } finally {
    await second.unmount();
  }
});
