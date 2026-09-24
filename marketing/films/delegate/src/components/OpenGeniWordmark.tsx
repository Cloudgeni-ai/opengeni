import React from "react";

/** Official wordmark as served on opengeni.ai (viewBox 958.43 × 100). */
const D =
  "M20,0 H103 A20,20 0 0 1 123,20 V80 A20,20 0 0 1 103,100 H20 A20,20 0 0 1 0,80 V20 A20,20 0 0 1 20,0 Z M20,20 H103 L103,20 V80 L103,80 H20 L20,80 V20 L20,20 Z M143,0 H239 A20,20 0 0 1 259,20 V50 A20,20 0 0 1 239,70 H163 V100 H143 Z M163,20 H239 L239,20 V50 L239,50 H163 L163,50 V20 L163,20 Z M279,0 H389 V20 H299 V40 H379 V60 H299 V80 H389 V100 H279 Z M409,0 H429 L500.72,71.72 V0 H520.72 V100 H500.72 L429,28.28 V100 H409 Z M560.72,0 H650.72 V20 H560.72 V80 H636.72 V60 H593.72 V40 H656.72 V100 H560.72 A20,20 0 0 1 540.72,80 V20 A20,20 0 0 1 560.72,0 Z M676.72,0 H786.72 V20 H696.72 V40 H776.72 V60 H696.72 V80 H786.72 V100 H676.72 Z M806.72,0 H826.72 L898.43,71.72 V0 H918.43 V100 H898.43 L826.72,28.28 V100 H806.72 Z M938.43,0 h20 v100 h-20 Z";

export const OpenGeniWordmark: React.FC<{ height: number; color: string }> = ({ height, color }) => (
  <svg width={(height * 958.43) / 100} height={height} viewBox="0 0 958.43 100" style={{ display: "block" }} role="img" aria-label="Opengeni">
    <path fillRule="evenodd" d={D} fill={color} />
  </svg>
);
