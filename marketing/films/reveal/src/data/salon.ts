import type { ServiceKind } from "../theme";

// The fictional product: "chair", a booking app for independent stylists.
// The tenant: Studio Lena. Today is Thursday 24 September 2026.

export const GRID = {
  top: 214,
  hourPx: 90,
  startHour: 9,
  endHour: 18,
  colWidth: 276,
  todayX: 136,
  weekX: 484,
  gutterRight: 118,
  blockInsetX: 6,
  blockInsetY: 2,
} as const;

export const WEEK_DAYS = [
  { short: "Mon", date: "28" },
  { short: "Tue", date: "29" },
  { short: "Wed", date: "30" },
  { short: "Thu", date: "1" },
  { short: "Fri", date: "2" },
] as const;

export type Appointment = {
  id: string;
  client: string;
  first: string;
  service: string;
  kind: ServiceKind;
  start: number;
  duration: number;
  to: { day: number; start: number };
  reason: string;
};

export const TODAY: Appointment[] = [
  {
    id: "ana",
    client: "Ana Ruiz",
    first: "Ana",
    service: "Cut & gloss",
    kind: "cut",
    start: 9,
    duration: 0.75,
    to: { day: 1, start: 9 },
    reason: "her mornings",
  },
  {
    id: "marcus",
    client: "Marcus Bell",
    first: "Marcus",
    service: "Beard & fade",
    kind: "style",
    start: 9.75,
    duration: 0.75,
    to: { day: 4, start: 10 },
    reason: "prefers Fridays",
  },
  {
    id: "priya",
    client: "Priya Nair",
    first: "Priya",
    service: "Balayage",
    kind: "long",
    start: 10.5,
    duration: 3,
    to: { day: 2, start: 12 },
    reason: "fits 3 hours",
  },
  {
    id: "joon",
    client: "Joon Park",
    first: "Joon",
    service: "Cut",
    kind: "cut",
    start: 14,
    duration: 0.75,
    to: { day: 0, start: 14 },
    reason: "same time",
  },
  {
    id: "elle",
    client: "Elle Dubois",
    first: "Elle",
    service: "Color refresh",
    kind: "color",
    start: 15,
    duration: 1,
    to: { day: 3, start: 15 },
    reason: "same time",
  },
  {
    id: "tom",
    client: "Tom Weller",
    first: "Tom",
    service: "Cut & style",
    kind: "style",
    start: 16.5,
    duration: 1,
    to: { day: 1, start: 17 },
    reason: "after work",
  },
];

export type Booked = { day: number; start: number; duration: number; client: string };

export const BOOKED: Booked[] = [
  { day: 0, start: 9, duration: 1.5, client: "K. Obi" },
  { day: 0, start: 11, duration: 1, client: "Sam T." },
  { day: 0, start: 15.5, duration: 1.5, client: "Rhea M." },
  { day: 1, start: 10, duration: 2.5, client: "J. Lund" },
  { day: 1, start: 13.5, duration: 1.5, client: "Nia P." },
  { day: 1, start: 15.5, duration: 1, client: "Omar A." },
  { day: 2, start: 9, duration: 2.5, client: "Chloe V." },
  { day: 2, start: 15.5, duration: 2, client: "Dev R." },
  { day: 3, start: 9.5, duration: 1.5, client: "Mia S." },
  { day: 3, start: 12, duration: 2.5, client: "Leo F." },
  { day: 3, start: 16.5, duration: 1.5, client: "Ines G." },
  { day: 4, start: 9, duration: 0.75, client: "Yusuf K." },
  { day: 4, start: 11, duration: 2, client: "Ava C." },
  { day: 4, start: 14, duration: 2, client: "Ben H." },
];

export function hourY(hour: number): number {
  return GRID.top + (hour - GRID.startHour) * GRID.hourPx;
}

export function todayRect(a: Appointment) {
  return {
    x: GRID.todayX + GRID.blockInsetX,
    y: hourY(a.start) + GRID.blockInsetY,
    w: GRID.colWidth - GRID.blockInsetX * 2,
    h: a.duration * GRID.hourPx - GRID.blockInsetY * 2,
  };
}

export function weekRect(day: number, start: number, duration: number) {
  return {
    x: GRID.weekX + day * GRID.colWidth + GRID.blockInsetX,
    y: hourY(start) + GRID.blockInsetY,
    w: GRID.colWidth - GRID.blockInsetX * 2,
    h: duration * GRID.hourPx - GRID.blockInsetY * 2,
  };
}

export function formatHour(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${h}:${m.toString().padStart(2, "0")}`;
}

export const MESSAGE_PREVIEW =
  "Hi Ana — Lena's out sick today, so I've moved you to Tue 29 at 9:00. Just reply if that doesn't work.";
