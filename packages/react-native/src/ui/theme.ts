// Design tokens for the native agent surfaces. A host picks a direction and a color scheme,
// and may override any token (brand accent, typography) without forking components.

export type ActivityStyle = "fold" | "rail" | "cards";
export type ComposerStyle = "pill" | "bar" | "voice";
export type UserMessageStyle = "bubble" | "plain";

export interface AgentTheme {
  id: string;
  scheme: "light" | "dark";
  colors: {
    background: string;
    surface: string;
    surfaceRaised: string;
    border: string;
    text: string;
    textMuted: string;
    textFaint: string;
    accent: string;
    onAccent: string;
    userBubble: string;
    onUserBubble: string;
    attention: string;
    attentionSurface: string;
    success: string;
    danger: string;
    dangerSurface: string;
    codeBackground: string;
    rail: string;
  };
  type: {
    body: number;
    bodyLine: number;
    small: number;
    smallLine: number;
    title: number;
    mono: string;
    weightStrong: "600" | "700";
  };
  radius: { bubble: number; card: number; composer: number; control: number };
  space: { gutter: number; row: number; turn: number };
  layout: {
    activity: ActivityStyle;
    composer: ComposerStyle;
    userMessage: UserMessageStyle;
    /** Minimum interactive size in points. */
    target: number;
  };
}

export type AgentDirectionId = "calm" | "workbench" | "field";

export interface AgentDirection {
  id: AgentDirectionId;
  name: string;
  summary: string;
  theme(scheme: "light" | "dark"): AgentTheme;
}

const mono = "Menlo";

/** Quiet conversation: prose answers, soft user bubbles, work folded to one line. */
const calm: AgentDirection = {
  id: "calm",
  name: "Calm",
  summary: "Prose-first conversation; agent work folds into one quiet line.",
  theme: (scheme) => ({
    id: "calm",
    scheme,
    colors:
      scheme === "light"
        ? {
            background: "#FFFFFF",
            surface: "#F6F6F4",
            surfaceRaised: "#FFFFFF",
            border: "#E7E6E2",
            text: "#1A1A19",
            textMuted: "#6B6A66",
            textFaint: "#A3A19C",
            accent: "#1A1A19",
            onAccent: "#FFFFFF",
            userBubble: "#F0EFEC",
            onUserBubble: "#1A1A19",
            attention: "#C2410C",
            attentionSurface: "#FFF4ED",
            success: "#15803D",
            danger: "#B42318",
            dangerSurface: "#FEF3F2",
            codeBackground: "#F6F6F4",
            rail: "#E7E6E2",
          }
        : {
            background: "#161615",
            surface: "#21211F",
            surfaceRaised: "#2A2A28",
            border: "#33332F",
            text: "#F2F1EE",
            textMuted: "#A3A19C",
            textFaint: "#6B6A66",
            accent: "#F2F1EE",
            onAccent: "#161615",
            userBubble: "#2A2A28",
            onUserBubble: "#F2F1EE",
            attention: "#FB923C",
            attentionSurface: "#2B1D14",
            success: "#4ADE80",
            danger: "#F97066",
            dangerSurface: "#2D1715",
            codeBackground: "#21211F",
            rail: "#33332F",
          },
    type: { body: 16, bodyLine: 24, small: 13, smallLine: 18, title: 20, mono, weightStrong: "600" },
    radius: { bubble: 20, card: 16, composer: 26, control: 18 },
    space: { gutter: 20, row: 10, turn: 28 },
    layout: { activity: "fold", composer: "pill", userMessage: "bubble", target: 44 },
  }),
};

/** Technical: visible step rail, monospace detail, dense and inspectable. */
const workbench: AgentDirection = {
  id: "workbench",
  name: "Workbench",
  summary: "Every step on a visible rail; dense, inspectable, built for long agent runs.",
  theme: (scheme) => ({
    id: "workbench",
    scheme,
    colors:
      scheme === "light"
        ? {
            background: "#FBFBFC",
            surface: "#F1F2F5",
            surfaceRaised: "#FFFFFF",
            border: "#E2E4EA",
            text: "#0F1115",
            textMuted: "#5B6170",
            textFaint: "#9AA0AD",
            accent: "#3B5BDB",
            onAccent: "#FFFFFF",
            userBubble: "#3B5BDB",
            onUserBubble: "#FFFFFF",
            attention: "#D97706",
            attentionSurface: "#FFF8EB",
            success: "#12B76A",
            danger: "#E5484D",
            dangerSurface: "#FFF0F0",
            codeBackground: "#F1F2F5",
            rail: "#D5D8E0",
          }
        : {
            background: "#0D0F13",
            surface: "#161920",
            surfaceRaised: "#1C2029",
            border: "#262A35",
            text: "#E8EAF0",
            textMuted: "#9AA0AD",
            textFaint: "#5B6170",
            accent: "#7C93FF",
            onAccent: "#0D0F13",
            userBubble: "#2A3566",
            onUserBubble: "#E8EAF0",
            attention: "#FBBF24",
            attentionSurface: "#2A2110",
            success: "#3DD68C",
            danger: "#FF6369",
            dangerSurface: "#2A1416",
            codeBackground: "#161920",
            rail: "#2E3340",
          },
    type: { body: 15, bodyLine: 22, small: 12, smallLine: 16, title: 18, mono, weightStrong: "600" },
    radius: { bubble: 14, card: 12, composer: 14, control: 10 },
    space: { gutter: 16, row: 8, turn: 22 },
    layout: { activity: "rail", composer: "bar", userMessage: "bubble", target: 44 },
  }),
};

/** Field: big type and targets, decisions as bold cards, voice-first composer. */
const field: AgentDirection = {
  id: "field",
  name: "Field",
  summary: "Large type and targets, decisions as bold cards, voice-first. Usable with gloves.",
  theme: (scheme) => ({
    id: "field",
    scheme,
    colors:
      scheme === "light"
        ? {
            background: "#F4F3EF",
            surface: "#FFFFFF",
            surfaceRaised: "#FFFFFF",
            border: "#E3E1DA",
            text: "#121212",
            textMuted: "#5C5A55",
            textFaint: "#97948C",
            accent: "#1F5FD6",
            onAccent: "#FFFFFF",
            userBubble: "#121212",
            onUserBubble: "#FFFFFF",
            attention: "#E8590C",
            attentionSurface: "#FFF1E6",
            success: "#2F9E44",
            danger: "#C92A2A",
            dangerSurface: "#FFF0F0",
            codeBackground: "#EFEDE7",
            rail: "#E3E1DA",
          }
        : {
            background: "#111110",
            surface: "#1D1C1A",
            surfaceRaised: "#252421",
            border: "#302E2A",
            text: "#F5F4F0",
            textMuted: "#B1AEA6",
            textFaint: "#77746D",
            accent: "#5C8DF6",
            onAccent: "#0B0B0A",
            userBubble: "#F5F4F0",
            onUserBubble: "#111110",
            attention: "#FF8A3D",
            attentionSurface: "#2E1F13",
            success: "#51CF66",
            danger: "#FF6B6B",
            dangerSurface: "#2E1616",
            codeBackground: "#1D1C1A",
            rail: "#302E2A",
          },
    type: { body: 18, bodyLine: 27, small: 15, smallLine: 20, title: 23, mono, weightStrong: "700" },
    radius: { bubble: 22, card: 20, composer: 30, control: 22 },
    space: { gutter: 18, row: 12, turn: 30 },
    layout: { activity: "cards", composer: "voice", userMessage: "bubble", target: 56 },
  }),
};

export const agentDirections: readonly AgentDirection[] = [calm, workbench, field];

export function agentTheme(direction: AgentDirectionId, scheme: "light" | "dark"): AgentTheme {
  return (agentDirections.find((entry) => entry.id === direction) ?? calm).theme(scheme);
}