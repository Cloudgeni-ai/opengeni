import { describe, expect, test } from "bun:test";
import { AGENT_ICON_COMPONENTS } from "../src/components/agent-icon-components";
import { AGENT_ICON_NAMES, agentIcon, normalizeAgentIcon } from "../src/lib/agent-icons";
import { AVATAR_STYLES, avatarColors, avatarStyleId } from "../src/lib/avatar-styles";

describe("agent icons", () => {
  test("loose icon names normalize, unknown ones do not", () => {
    expect(normalizeAgentIcon(" Rocket ")).toBe("rocket");
    expect(normalizeAgentIcon("not-an-icon")).toBeNull();
    expect(normalizeAgentIcon(42)).toBeNull();
  });

  test("every icon name has a component", () => {
    expect(Object.keys(AGENT_ICON_COMPONENTS).sort()).toEqual([...AGENT_ICON_NAMES].sort());
  });

  test("an agent's own known pick wins", () => {
    expect(agentIcon({ icon: "rocket", name: "Finance" })).toBe("rocket");
  });

  test("unknown picks and missing picks fall back to the best keyword match", () => {
    expect(agentIcon({ icon: "not-an-icon", name: "Finance" })).toBe("wallet");
    expect(agentIcon({ name: "Meals" })).toBe("utensils");
    expect(agentIcon({ name: "Running coach" })).toBe("footprints");
    expect(agentIcon({ name: "Orbit", description: "Digs into research papers" })).toBe(
      "telescope",
    );
  });

  test("nothing to go on gives no icon", () => {
    expect(agentIcon({ name: "Zork" })).toBeNull();
    expect(agentIcon({})).toBeNull();
  });
});

describe("avatar styles", () => {
  test("unknown and legacy style ids fall back to the default", () => {
    expect(avatarStyleId("og-mono")).toBe("soft");
    expect(avatarStyleId("ink")).toBe("ink");
  });

  test("every style gives colors in light and dark, stable per agent", () => {
    for (const style of AVATAR_STYLES) {
      for (const dark of [false, true]) {
        const colors = avatarColors(style.id, "agent-1", dark);
        expect(colors.background).toBeTruthy();
        expect(colors.glyph).toBeTruthy();
        expect(avatarColors(style.id, "agent-1", dark)).toEqual(colors);
      }
    }
  });
});
