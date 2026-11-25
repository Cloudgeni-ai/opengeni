import { SkillDiscovery as Catalog, type SkillDiscoveryProps } from "@opengeni/react/connect";
import { BookOpenIcon } from "lucide-react";

import { CapabilityMark } from "@opengeni/react/ui/capability-page";
import { humanizeName } from "@opengeni/react/app/lib/skill-names";

/** The skills.sh catalog with product names: "Agent browser", "From vercel-labs on skills.sh". */
export function SkillDiscovery(props: SkillDiscoveryProps) {
  return (
    <Catalog
      formatName={humanizeName}
      formatSource={(source) => `From ${source.split("/")[0] ?? source} on skills.sh`}
      icon={<CapabilityMark name="Skill" icon={<BookOpenIcon />} />}
      {...props}
    />
  );
}
