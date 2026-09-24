import React from "react";

type IconProps = { size?: number; color?: string; stroke?: number; style?: React.CSSProperties };

const base = (size: number, style?: React.CSSProperties) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  style: { display: "block", flexShrink: 0, ...style },
});

export const Sparkle: React.FC<IconProps & { spin?: number }> = ({ size = 20, color = "currentColor", spin = 0, style }) => (
  <svg {...base(size, { ...style, transform: `rotate(${spin}deg)` })}>
    <path
      d="M12 2.5c.5 4.6 2.4 6.9 7 7.5-4.6.6-6.5 2.9-7 7.5-.5-4.6-2.4-6.9-7-7.5 4.6-.6 6.5-2.9 7-7.5Z"
      fill={color}
    />
    <path d="M19 15.5c.2 1.8 1 2.7 2.7 2.9-1.7.2-2.5 1.1-2.7 2.9-.2-1.8-1-2.7-2.7-2.9 1.7-.2 2.5-1.1 2.7-2.9Z" fill={color} opacity={0.7} />
  </svg>
);

export const Moon: React.FC<IconProps> = ({ size = 18, color = "currentColor", stroke = 1.8, style }) => (
  <svg {...base(size, style)}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" stroke={color} strokeWidth={stroke} strokeLinejoin="round" />
  </svg>
);

export const Search: React.FC<IconProps> = ({ size = 18, color = "currentColor", stroke = 1.8, style }) => (
  <svg {...base(size, style)}>
    <circle cx="11" cy="11" r="6.5" stroke={color} strokeWidth={stroke} />
    <path d="m16 16 4 4" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
  </svg>
);

export const Bell: React.FC<IconProps> = ({ size = 18, color = "currentColor", stroke = 1.8, style }) => (
  <svg {...base(size, style)}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z" stroke={color} strokeWidth={stroke} strokeLinejoin="round" />
    <path d="M10 20.5a2.2 2.2 0 0 0 4 0" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
  </svg>
);

export const Chevron: React.FC<IconProps & { dir?: "left" | "right" | "down" }> = ({
  size = 16,
  color = "currentColor",
  stroke = 2,
  dir = "right",
  style,
}) => {
  const d = dir === "left" ? "M15 5l-7 7 7 7" : dir === "right" ? "M9 5l7 7-7 7" : "M6 9l6 6 6-6";
  return (
    <svg {...base(size, style)}>
      <path d={d} stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

export const Check: React.FC<IconProps> = ({ size = 14, color = "currentColor", stroke = 2.6, style }) => (
  <svg {...base(size, style)}>
    <path d="M5 12.5l4.2 4.2L19 7" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const Close: React.FC<IconProps> = ({ size = 16, color = "currentColor", stroke = 2, style }) => (
  <svg {...base(size, style)}>
    <path d="M6 6l12 12M18 6 6 18" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
  </svg>
);

export const Send: React.FC<IconProps> = ({ size = 16, color = "currentColor", stroke = 2, style }) => (
  <svg {...base(size, style)}>
    <path d="M4 12 20 4l-6 16-2.5-6.5L4 12Z" stroke={color} strokeWidth={stroke} strokeLinejoin="round" />
  </svg>
);

export const ArrowUp: React.FC<IconProps> = ({ size = 16, color = "currentColor", stroke = 2.2, style }) => (
  <svg {...base(size, style)}>
    <path d="M12 19V5M6 11l6-6 6 6" stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
