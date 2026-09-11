import { ConnectionInstalled } from "@opengeni/react/connect";
import "@opengeni/react/connect.css";
import { ConnectionLogo } from "@opengeni/react/connect";

export type InstalledStripItem = {
  id: string;
  name: string;
  status: string;
  logoSrc: string | null;
  onOpen: () => void;
};

export function InstalledStrip({
  items,
  title = "Installed",
}: {
  items: InstalledStripItem[];
  title?: string;
}) {
  return (
    <ConnectionInstalled
      title={title}
      items={items.map((item) => ({
        ...item,
        needsAttention: item.status === "Needs attention",
        icon: <ConnectionLogo src={item.logoSrc} name={item.name} size={40} />,
      }))}
    />
  );
}
