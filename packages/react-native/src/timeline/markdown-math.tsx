/* Math in native chat messages. `prepareMathMarkdown` (shared with the web) turns every
   math span into `$$…$$`, `markdown-math-parser.ts` parses that form, and these views
   draw each formula as an SVG. The MathJax engine loads on the first formula. */
import { useMemo } from "react";
import { ScrollView, Text, View, type TextStyle } from "react-native";
import { SvgXml } from "react-native-svg";
import type { MathEngine } from "./math-engine";

let engine: MathEngine | null = null;

function typeset(tex: string, display: boolean) {
  if (!engine) {
    // Synchronous and on first use: Metro bundles the module but evaluates it only here.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const module = require("./math-engine") as typeof import("./math-engine");
    engine = module.createMathEngine();
  }
  return engine(tex, display);
}

/** One ex of the message font, in points (TeX fonts: about 0.43 em). */
const EX_PER_EM = 0.431;

/** A formula inside a line of text. */
export function InlineMath({
  tex,
  fontSize,
  color,
  fallbackStyle,
}: {
  tex: string;
  fontSize: number;
  color: string;
  fallbackStyle: TextStyle;
}) {
  const math = useMemo(() => typeset(tex, false), [tex]);
  if (!math) return <Text style={fallbackStyle}>{tex}</Text>;
  const ex = fontSize * EX_PER_EM;
  return (
    <View
      accessible
      accessibilityLabel={tex}
      style={{ transform: [{ translateY: math.depth * ex }] }}
    >
      <SvgXml xml={math.svg} width={math.width * ex} height={math.height * ex} color={color} />
    </View>
  );
}

/** A formula on its own lines, centred, scrolling sideways when wider than the message. */
export function DisplayMath({
  tex,
  fontSize,
  color,
  fallbackStyle,
}: {
  tex: string;
  fontSize: number;
  color: string;
  fallbackStyle: TextStyle;
}) {
  const math = useMemo(() => typeset(tex, true), [tex]);
  if (!math) {
    return (
      <Text selectable style={[fallbackStyle, { marginBottom: 10 }]}>
        {tex}
      </Text>
    );
  }
  const ex = fontSize * EX_PER_EM;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginTop: 2, marginBottom: 12 }}
      contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}
    >
      <View accessible accessibilityLabel={tex}>
        <SvgXml xml={math.svg} width={math.width * ex} height={math.height * ex} color={color} />
      </View>
    </ScrollView>
  );
}
