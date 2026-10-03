import Svg, { Circle, Line, Path, Polyline, Rect } from "react-native-svg";
import { iconNodes, type NativeIconName } from "./icon-nodes.generated";

export type { NativeIconName };

const ELEMENTS = { path: Path, circle: Circle, rect: Rect, line: Line, polyline: Polyline };

/** One lucide glyph with the web's geometry (24 viewBox, 2px round stroke). */
export function Icon({
  name,
  size = 14,
  color,
  strokeWidth = 2,
}: {
  name: NativeIconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}) {
  const node = iconNodes[name] as ReadonlyArray<readonly [string, Record<string, string | number>]>;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {node.map(([tag, attrs], index) => {
        const Element = ELEMENTS[tag as keyof typeof ELEMENTS];
        if (!Element) return null;
        const props = { ...attrs } as Record<string, unknown>;
        return (
          <Element
            key={index}
            {...props}
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        );
      })}
    </Svg>
  );
}
