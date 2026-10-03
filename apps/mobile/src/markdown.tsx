import type { AgentTheme } from "@opengeni/react-native/ui";
import Markdown from "react-native-markdown-display";

/** Themed Markdown for assistant prose. */
export function renderAgentMarkdown(text: string, theme: AgentTheme) {
  const c = theme.colors;
  const body = { color: c.text, fontSize: theme.type.body, lineHeight: theme.type.bodyLine };
  return (
    <Markdown
      style={{
        body,
        paragraph: { marginTop: 0, marginBottom: theme.type.body * 0.6 },
        heading1: { ...body, fontSize: theme.type.title + 2, lineHeight: theme.type.title + 10, fontWeight: "700", marginTop: 8, marginBottom: 6 },
        heading2: { ...body, fontSize: theme.type.title, lineHeight: theme.type.title + 8, fontWeight: "700", marginTop: 8, marginBottom: 6 },
        heading3: { ...body, fontSize: theme.type.body + 1, fontWeight: "700", marginTop: 10, marginBottom: 4 },
        strong: { fontWeight: theme.type.weightStrong },
        bullet_list: { marginBottom: 8 },
        ordered_list: { marginBottom: 8 },
        list_item: { marginBottom: 4 },
        code_inline: { fontFamily: theme.type.mono, fontSize: theme.type.body - 2, backgroundColor: c.codeBackground, color: c.text, borderRadius: 4, paddingHorizontal: 4 },
        fence: { fontFamily: theme.type.mono, fontSize: theme.type.small, lineHeight: theme.type.smallLine, backgroundColor: c.codeBackground, color: c.text, borderColor: c.border, borderWidth: 0, borderRadius: theme.radius.control, padding: 12, marginVertical: 6 },
        code_block: { fontFamily: theme.type.mono, backgroundColor: c.codeBackground, color: c.text },
        link: { color: c.accent, textDecorationLine: "underline" },
        blockquote: { backgroundColor: c.surface, borderLeftColor: c.border, borderLeftWidth: 3, paddingHorizontal: 10 },
        hr: { backgroundColor: c.border },
      }}
    >
      {text}
    </Markdown>
  );
}