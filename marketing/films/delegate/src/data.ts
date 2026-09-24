/** One coherent state for the whole film: Ines's booking app, "hour",
 * on Monday Oct 13 at 11:48 PM. Tomorrow (Tue Oct 14) has seven clients. */

export type Client = {
  id: string;
  name: string;
  initials: string;
  service: string;
  duration: string;
  color: string;
  /** Tomorrow's slot (display). */
  time: string;
  /** Learned from booking history; shown while the agent checks. */
  usual: string;
  /** Destination next week: day index 0 = Mon 20 … 5 = Sat 25, hours as decimals. */
  to: { day: number; start: number; hours: number; label: string };
};

export const CLIENTS: Client[] = [
  {
    id: "ben",
    name: "Ben Carter",
    initials: "BC",
    service: "Cut",
    duration: "45 min",
    color: "#7ea8ff",
    time: "9:00",
    usual: "usually Thu 5 pm",
    to: { day: 3, start: 17, hours: 0.75, label: "Thu 5:00" },
  },
  {
    id: "priya",
    name: "Priya Nair",
    initials: "PN",
    service: "Color & gloss",
    duration: "2 h",
    color: "#ff90b3",
    time: "10:00",
    usual: "usually Mon 10 am",
    to: { day: 0, start: 10, hours: 2, label: "Mon 10:00" },
  },
  {
    id: "sam",
    name: "Sam Okafor",
    initials: "SO",
    service: "Trim",
    duration: "30 min",
    color: "#ffc86e",
    time: "12:30",
    usual: "usually lunch, 12:30",
    to: { day: 2, start: 12.5, hours: 0.5, label: "Wed 12:30" },
  },
  {
    id: "lena",
    name: "Lena Vogel",
    initials: "LV",
    service: "Balayage",
    duration: "2 h 30",
    color: "#b89aff",
    time: "1:30",
    usual: "usually Fri mornings",
    to: { day: 4, start: 9.5, hours: 2.5, label: "Fri 9:30" },
  },
  {
    id: "omar",
    name: "Omar Haddad",
    initials: "OH",
    service: "Cut & beard",
    duration: "1 h",
    color: "#62d6d2",
    time: "3:00",
    usual: "usually Tue 3 pm",
    to: { day: 1, start: 15, hours: 1, label: "Tue 3:00" },
  },
  {
    id: "june",
    name: "June Park",
    initials: "JP",
    service: "Blowout",
    duration: "45 min",
    color: "#ff8d7d",
    time: "4:30",
    usual: "usually after work",
    to: { day: 2, start: 16.5, hours: 0.75, label: "Wed 4:30" },
  },
  {
    id: "marco",
    name: "Marco Rossi",
    initials: "MR",
    service: "Cut",
    duration: "45 min",
    color: "#aedb74",
    time: "5:30",
    usual: "usually Sat 9:30",
    to: { day: 5, start: 9.5, hours: 0.75, label: "Sat 9:30" },
  },
];

/** Other clients already booked next week (the gaps are real). */
export const EXISTING: { day: number; start: number; hours: number; name: string }[] = [
  { day: 0, start: 9, hours: 1, name: "Ava Lind" },
  { day: 0, start: 12, hours: 1.5, name: "Rui Costa" },
  { day: 0, start: 14, hours: 1, name: "Kim Tran" },
  { day: 0, start: 16, hours: 1.5, name: "Noah Berg" },
  { day: 1, start: 9.5, hours: 1.5, name: "Elif Aydın" },
  { day: 1, start: 11.5, hours: 1, name: "Tom Hale" },
  { day: 1, start: 13, hours: 1.5, name: "Hana Sato" },
  { day: 1, start: 16.5, hours: 1.5, name: "Leo Marsh" },
  { day: 2, start: 9, hours: 1.5, name: "Maja Novak" },
  { day: 2, start: 10.5, hours: 1.5, name: "Ivy Chen" },
  { day: 2, start: 14, hours: 2, name: "Sara Holm" },
  { day: 3, start: 9, hours: 1, name: "Dev Patel" },
  { day: 3, start: 10.5, hours: 2, name: "Mila Ross" },
  { day: 3, start: 13, hours: 1, name: "Aki Mori" },
  { day: 3, start: 14.5, hours: 2, name: "Zoe Hart" },
  { day: 4, start: 12, hours: 1, name: "Finn Ó Dála" },
  { day: 4, start: 13.5, hours: 2, name: "Nia Brooks" },
  { day: 4, start: 16, hours: 1, name: "Oli Grant" },
  { day: 5, start: 11, hours: 1.5, name: "Bea Ortiz" },
  { day: 5, start: 13, hours: 1, name: "Jon Weiss" },
  { day: 5, start: 14.5, hours: 1.5, name: "Ula Kim" },
];

export const DAYS = ["Mon 20", "Tue 21", "Wed 22", "Thu 23", "Fri 24", "Sat 25"];

/** App geometry, in app pixels (the app is authored at 1920×1080). */
export const G = {
  top: 76,
  colW: 620,
  cardX: 28,
  cardW: 564,
  cardH: 84,
  cardGap: 12,
  listY: 330,
  gridX: 620,
  gutter: 66,
  gridTop: 158,
  hourH: 84,
  firstHour: 9,
  lastHour: 18,
  dayW: (1920 - 620 - 66 - 18) / 6,
  askX: 28,
  /** The ask bar sits at the top of the Tomorrow column and grows downward. */
  askY: 192,
  askW: 564,
  askH: 68,
} as const;

export type Rect = { x: number; y: number; w: number; h: number };

export function cardRect(i: number): Rect {
  return { x: G.cardX, y: G.listY + i * (G.cardH + G.cardGap), w: G.cardW, h: G.cardH };
}

export function slotRect(day: number, start: number, hours: number): Rect {
  const x = G.gridX + G.gutter + day * G.dayW + 5;
  const y = G.gridTop + (start - G.firstHour) * G.hourH + 2;
  return { x, y, w: G.dayW - 10, h: hours * G.hourH - 4 };
}

export const REQUEST = "I'm sick. Move tomorrow's clients to next week and let them know.";

export const PREVIEW = {
  to: "Ben Carter",
  body: "Hi Ben — I'm sick tomorrow, so I've moved you to Thursday at 5:00, your usual time. Sorry for the shuffle! — Ines",
};
