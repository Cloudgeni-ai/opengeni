# Upstream plugin catalogue

Run `bun run catalog:refresh-plugins` to refresh
`data/catalog/plugins-snapshot.json` from the public OpenAI and Anthropic
marketplace indexes. The snapshot is discovery metadata, not installed plugins.
It is separate from our integration catalogue and custom manifests.

Each source records an immutable Git revision. Entries retain their provider,
name, display name, descriptions, category, keywords, author, version, license
when declared, artwork URLs, original source declaration and installation policy.
Artwork remains upstream URLs pinned to the revision; we do not download logos.
Missing metadata stays null rather than being invented.

Local marketplace entries also list detected skills, MCP, apps, hooks, agents,
commands and LSP components. External GitHub sources are inspected during sync
at the commit pinned in the registry. Bounded temporary archives avoid GitHub
REST requests per external repository; archives are deleted after metadata
extraction. Repositories without supported pinned sources or failed archive
reads remain explicitly unknown. Search and previews do not inspect repositories.
An entry being listed by an official marketplace does not mean its author is
OpenAI or Anthropic. Preserve both provider and author in presentation.

The refresh uses six concurrent manifest reads, validates nonempty indexes,
and replaces the snapshot only after both sources succeed. No repository scans
happen during search. No executable upstream files are copied or executed.

The marketplace adapter installs indexed skills and references supported remote MCP connections. A catalogue entry must
not be sent directly to OpenGeni's plugin-manifest installer: these are different
manifest formats. MCP connections and skills can be mapped to our existing
primitives; hosted apps, commands, hooks and agent definitions require explicit
runtime support. Retain upstream licensing and source attribution when importing
content; missing licensing metadata is not a license grant.

The workspace-authorized capabilities discovery API serves paginated search from
this snapshot. SDK `discoverPlugins` and React `PluginDiscovery` expose it to
embedders. The web Plugins tab composes discovery with its installed inventory
and a source preview. Unsupported components remain visible but are not installed.
