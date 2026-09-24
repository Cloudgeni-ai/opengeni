// The exact handler shown on screen. Verified against packages/sdk/src/chat
// (see notes/03-truth-ledger.md). Do not "simplify" it into something the SDK
// does not accept.
export const CODE_SOURCE = `import { OpenGeni, createChatHandler } from "@opengeni/sdk/chat";

const og = new OpenGeni({
  apiKey: process.env.OPENGENI_API_KEY!,
  organizationId: process.env.OPENGENI_ORGANIZATION_ID!,
});

const handler = createChatHandler(og, {
  resolve: async (request) => {
    const me = await authenticate(request);
    return {
      tenant: me.accountId,
      user: me.userId,
      tools: [{ kind: "mcp", id: "app" }],
      create: {
        mcpServers: [{
          id: "app",
          url: "https://yourapp.com/mcp", // your app's own actions
          headers: { authorization: \`Bearer \${me.token}\` },
          requireApproval: ["send_messages"],
        }],
      },
    };
  },
});

export { handler as GET, handler as POST };`;

export const CODE_LINES = CODE_SOURCE.split("\n");

export type TokenKind = "kw" | "id" | "str" | "punct" | "com" | "prop" | "space";
export type Token = { text: string; kind: TokenKind };

const KEYWORDS = new Set(["import", "from", "const", "new", "async", "await", "return", "export", "as"]);

export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const ws = /^\s+/.exec(rest);
    if (ws) {
      tokens.push({ text: ws[0], kind: "space" });
      i += ws[0].length;
      continue;
    }
    if (rest.startsWith("//")) {
      tokens.push({ text: rest, kind: "com" });
      break;
    }
    const str = /^("[^"]*"|`[^`]*`)/.exec(rest);
    if (str) {
      tokens.push({ text: str[0], kind: "str" });
      i += str[0].length;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      const after = line.slice(i + word[0].length);
      const kind: TokenKind = KEYWORDS.has(word[0]) ? "kw" : /^\s*:/.test(after) ? "prop" : "id";
      tokens.push({ text: word[0], kind });
      i += word[0].length;
      continue;
    }
    tokens.push({ text: rest[0], kind: "punct" });
    i += 1;
  }
  return tokens;
}

export type HighlightKey = "tenant" | "tools" | "approval";

/** 1-based inclusive line ranges, the line the cue is centred on, and the
 * lines whose text the cue must stay clear of horizontally. */
export const HIGHLIGHTS: Record<HighlightKey, { from: number; to: number; cueLine: number; clear: number[] }> = {
  tenant: { from: 12, to: 13, cueLine: 12.5, clear: [12, 13] },
  tools: { from: 14, to: 18, cueLine: 14, clear: [13, 14, 15] },
  approval: { from: 20, to: 20, cueLine: 20, clear: [19, 20, 21] },
};
