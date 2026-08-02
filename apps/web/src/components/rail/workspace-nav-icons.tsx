import {
  BoxIcon,
  BrainCircuitIcon,
  CalendarClockIcon,
  FileSearchIcon,
  GaugeIcon,
  LaptopIcon,
  MapIcon,
  PanelsTopLeftIcon,
  PlugIcon,
  ServerCogIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";

import type { WorkspaceConfigIcon } from "@/components/rail/workspace-nav-data";

export const WORKSPACE_CONFIG_ICONS: Record<WorkspaceConfigIcon, LucideIcon> = {
  gauge: GaugeIcon,
  box: BoxIcon,
  "server-cog": ServerCogIcon,
  laptop: LaptopIcon,
  "file-search": FileSearchIcon,
  "brain-circuit": BrainCircuitIcon,
  map: MapIcon,
  plug: PlugIcon,
  "calendar-clock": CalendarClockIcon,
  "panels-top-left": PanelsTopLeftIcon,
  settings: SettingsIcon,
};
