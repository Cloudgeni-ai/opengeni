import React from "react";
import { F } from "../fonts";

/** Exact October live-site icon geometry; not the legacy uppercase wordmark. */
export const OpenGeniMark: React.FC<{size?: number; color?: string}> = ({size=64, color="currentColor"}) => (
  <svg width={size} height={size * 138.7295 / 176} viewBox="75 39.5966 176 138.7295" fill={color} aria-label="Opengeni">
    <path d="M251 83.5966L207 109L163 83.5966L119 109L75 83.5966L141 45.4915A44 44 0 0 1 185 45.4915ZM185.25 172.3642A44.5 44.5 0 0 1 140.75 172.3642L75 134.4034L119 109L163 134.4034L207 109L251 134.4034Z" />
  </svg>
);
export const OpenGeniWordmark: React.FC<{height:number; color:string}> = ({height,color}) => (
  <div style={{display:"flex",alignItems:"center",gap:height*.32,color,fontFamily:F.brandSans,fontSize:height,fontWeight:600,letterSpacing:"-.055em",lineHeight:1}}>
    <OpenGeniMark size={height*1.1} color={color}/><span>Opengeni</span>
  </div>
);