import { loadFont as loadArchivo } from "@remotion/google-fonts/Archivo";
import { loadFont as loadDmSans } from "@remotion/google-fonts/DMSans";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

// OpenGeni brand (opengeni.ai site tokens, 2026-09-24).
export const BRAND = {
  paper: "#f4f3ec",
  ink: "#242423",
  line: "#d5d5ca",
  muted: "#64645f",
  orange: "#f65327",
} as const;

// The fictional salon app keeps its own neutral palette so that the brand
// orange only ever marks the agent.
export const APP = {
  bg: "#fbfbf9",
  surface: "#ffffff",
  grid: "#eceae4",
  gridStrong: "#dedbd3",
  text: "#1d1d1b",
  sub: "#6f6d67",
  faint: "#a19e96",
  accent: "#2f5d50",
  booked: "#f1f0ec",
  bookedBar: "#c9c6bd",
  bookedText: "#8e8b83",
} as const;

export const SERVICE = {
  cut: { fill: "#e6eee8", bar: "#5f8b73", text: "#27493a" },
  color: { fill: "#ebe7f4", bar: "#7a6aa8", text: "#3e3466" },
  style: { fill: "#e3ecf3", bar: "#5a7f9c", text: "#2b4a61" },
  long: { fill: "#f1ebdd", bar: "#a38b58", text: "#5a4a26" },
} as const;

export type ServiceKind = keyof typeof SERVICE;

export const CODE = {
  bg: "#242423",
  text: "#ecebe4",
  keyword: "#a8a69d",
  punct: "#85837b",
  string: "#c8d3b4",
  comment: "#8b897f",
  gutter: "#5d5c56",
} as const;

export const archivo = loadArchivo("normal", {
  weights: ["500", "600", "700"],
  subsets: ["latin"],
}).fontFamily;

export const dmSans = loadDmSans("normal", {
  weights: ["400", "500", "600"],
  subsets: ["latin"],
}).fontFamily;

export const inter = loadInter("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
}).fontFamily;

export const mono = loadMono("normal", {
  weights: ["400", "500"],
  subsets: ["latin"],
}).fontFamily;
