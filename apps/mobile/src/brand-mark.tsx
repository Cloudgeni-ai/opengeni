import Svg, { Path } from "react-native-svg";

/** The Opengeni iconmark (two stacked chevrons, 176:138.73), as on web. */
export function BrandMark({ width = 14, color }: { width?: number; color: string }) {
  return (
    <Svg
      width={width}
      height={(width * 138.73) / 176}
      viewBox="0 0 176 138.73"
      accessibilityElementsHidden
    >
      <Path
        transform="translate(-75 -39.5966)"
        fill={color}
        d="M251 83.5966L207 109L163 83.5966L119 109L75 83.5966L141 45.4915A44 44 0 0 1 185 45.4915ZM185.25 172.3642A44.5 44.5 0 0 1 140.75 172.3642L75 134.4034L119 109L163 134.4034L207 109L251 134.4034Z"
      />
    </Svg>
  );
}