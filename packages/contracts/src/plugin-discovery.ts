/** Public discovery metadata; listing does not imply runtime compatibility. */
export type PluginDiscoveryItem = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  longDescription: string;
  provider: string;
  category: string | null;
  logoUrl: string | null;
  darkLogoUrl: string | null;
  sourceUrl: string | null;
  author: { name?: string } | null;
  version: string | null;
  skills?: { name: string; sourceUrl: string }[] | null;
  mcpServers?:
    | {
        name: string;
        transport: string;
        requiresConfiguration?: boolean;
        endpoint: string | null;
      }[]
    | null;
  components: string[] | null;
  installation: string;
};
export type PluginDiscoveryPage = {
  items: PluginDiscoveryItem[];
  total: number;
  nextOffset: number | null;
};
