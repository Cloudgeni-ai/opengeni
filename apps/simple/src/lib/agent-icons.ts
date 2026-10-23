/**
 * Agent avatars are icons from a curated set. An agent picks one by name; an
 * agent that has not picked one (or picked an unknown name) gets the best match
 * for its name and description. Icons are instant, crisp at any size and take
 * their colors from the avatar style.
 *
 * Shared by the server (to validate and list names in prompts) and the app.
 */
export const AGENT_ICONS: Record<string, string[]> = {
  // Work and business
  briefcase: ["work", "job", "career", "business", "office", "recruit"],
  "chart-line": ["analytics", "metrics", "growth", "stats", "data", "kpi", "trend"],
  "chart-pie": ["budget", "breakdown", "share", "portfolio"],
  wallet: ["finance", "money", "spending", "expenses", "personal finance"],
  "piggy-bank": ["savings", "save", "saving"],
  "receipt-text": ["invoice", "invoices", "billing", "receipts", "accounting", "bookkeeping"],
  landmark: ["bank", "tax", "taxes", "government", "legal"],
  scale: ["law", "lawyer", "contract", "contracts", "compliance", "policy"],
  handshake: ["sales", "deal", "deals", "partner", "partners", "crm", "client", "clients"],
  megaphone: ["marketing", "campaign", "announce", "ads", "promotion", "pr"],
  "trending-up": ["investing", "stocks", "market", "trading"],
  target: ["goal", "goals", "okr", "focus", "strategy"],
  presentation: ["pitch", "slides", "deck", "presentation"],
  users: ["team", "people", "hr", "hiring", "community"],
  "user-round": ["personal", "assistant", "profile"],
  building: ["company", "startup", "organization", "real estate"],
  "calendar-days": ["calendar", "schedule", "meeting", "meetings", "planner", "agenda"],
  "list-checks": ["tasks", "todo", "todos", "checklist", "project", "projects", "pm"],
  "clipboard-list": ["operations", "ops", "process", "admin"],
  inbox: ["email", "inbox", "triage", "support", "mail"],
  mail: ["newsletter", "outreach", "letters", "correspondence"],
  "message-circle": ["chat", "messages", "slack", "conversation", "reply"],
  headset: ["customer", "customers", "service", "helpdesk", "call"],
  "life-buoy": ["help", "rescue", "troubleshoot"],
  // Engineering
  "code-xml": ["code", "coding", "developer", "programming", "software", "engineer"],
  "git-pull-request": ["github", "gitlab", "repo", "repository", "pull request", "open source"],
  "git-branch": ["git", "branch", "release", "releases", "merge"],
  "square-terminal": ["terminal", "shell", "cli", "devops", "scripts"],
  bug: ["bug", "bugs", "debug", "qa", "testing", "issue", "issues"],
  server: ["server", "infrastructure", "infra", "backend", "hosting"],
  cloud: ["cloud", "aws", "azure", "gcp", "deploy", "deployment"],
  database: ["database", "sql", "warehouse", "records"],
  shield: ["security", "privacy", "safety", "audit", "protect"],
  "key-round": ["access", "passwords", "credentials", "auth"],
  cpu: ["hardware", "ai", "machine learning", "ml", "model"],
  bot: ["bot", "automation", "agent", "robot"],
  workflow: ["workflow", "pipeline", "integration", "zap"],
  "app-window": ["app", "product", "frontend", "web app", "website", "site"],
  smartphone: ["mobile", "ios", "android", "phone"],
  globe: ["web", "internet", "browse", "world", "international", "language", "translate"],
  wrench: ["fix", "maintenance", "repair", "tools", "setup"],
  // Research and knowledge
  "book-open": ["read", "reading", "book", "books", "study", "learn", "learning", "library"],
  "graduation-cap": ["school", "course", "education", "student", "tutor", "exam", "university"],
  telescope: ["research", "explore", "discovery", "investigate", "scout"],
  "flask-conical": ["science", "experiment", "experiments", "lab", "chemistry"],
  microscope: ["biology", "analysis", "deep dive"],
  search: ["search", "find", "lookup", "sourcing"],
  newspaper: ["news", "digest", "briefing", "brief", "headlines", "journalism"],
  lightbulb: ["idea", "ideas", "brainstorm", "innovation", "insight", "tips"],
  brain: ["think", "thinking", "memory", "knowledge", "mind", "psychology"],
  "notebook-pen": ["notes", "journal", "diary", "log", "notebook"],
  library: ["archive", "docs", "documentation", "wiki", "reference"],
  languages: ["languages", "spanish", "french", "german", "norwegian", "vocabulary"],
  // Writing and creative
  "pen-line": ["write", "writing", "writer", "edit", "editor", "copy", "copywriting", "blog"],
  feather: ["poetry", "story", "stories", "fiction", "author"],
  "file-text": ["document", "documents", "report", "reports", "summary", "summaries"],
  palette: ["design", "designer", "art", "brand", "branding", "color", "creative"],
  "pen-tool": ["illustration", "logo", "vector", "ux", "ui"],
  camera: ["photo", "photos", "photography", "instagram"],
  clapperboard: ["video", "film", "youtube", "movie", "movies", "edit video"],
  music: ["music", "song", "songs", "playlist", "band", "spotify"],
  mic: ["podcast", "voice", "speech", "interview", "audio"],
  "image-plus": ["images", "image", "thumbnail", "visual", "visuals"],
  sparkles: ["magic", "creative", "generate", "general", "anything"],
  "at-sign": ["social", "social media", "twitter", "x", "linkedin", "posts", "threads"],
  // Life and home
  house: ["home", "house", "household", "chores", "family home", "apartment"],
  "chef-hat": ["cook", "cooking", "chef", "recipe", "recipes"],
  utensils: ["meal", "meals", "food", "dinner", "restaurant", "meal plan"],
  salad: ["nutrition", "diet", "healthy", "eating", "calories"],
  coffee: ["coffee", "morning", "cafe", "routine"],
  "shopping-cart": ["shopping", "groceries", "grocery", "buy", "store", "ecommerce"],
  gift: ["gift", "gifts", "birthday", "present", "presents", "christmas"],
  "party-popper": ["party", "event", "events", "celebration", "wedding"],
  baby: ["baby", "kids", "parenting", "child", "children"],
  "paw-print": ["pet", "pets", "dog", "cat", "vet"],
  sprout: ["garden", "gardening", "plants", "growth", "habits"],
  leaf: ["environment", "climate", "sustainability", "green", "eco"],
  car: ["car", "cars", "drive", "vehicle", "commute"],
  plane: ["travel", "trip", "trips", "flight", "flights", "vacation", "holiday"],
  map: ["map", "route", "itinerary", "places", "local"],
  compass: ["guide", "direction", "navigator", "explorer", "advisor", "mentor"],
  tent: ["camping", "outdoors", "hiking", "adventure"],
  mountain: ["climb", "climbing", "ski", "skiing", "mountains"],
  // Health and fitness
  dumbbell: ["fitness", "gym", "workout", "workouts", "strength", "training", "coach"],
  footprints: ["run", "running", "walk", "walking", "steps", "marathon"],
  bike: ["bike", "cycling", "ride"],
  "heart-pulse": ["health", "medical", "doctor", "symptoms", "heart", "wellness"],
  pill: ["medicine", "medication", "pharmacy", "supplements"],
  moon: ["sleep", "night", "bedtime", "rest"],
  smile: ["mood", "happiness", "wellbeing", "therapy", "mental health", "friend"],
  heart: ["love", "relationship", "dating", "care", "kindness"],
  // Play and misc
  "gamepad-2": ["game", "games", "gaming", "play"],
  trophy: ["sport", "sports", "win", "competition", "league", "football", "soccer"],
  puzzle: ["puzzle", "puzzles", "riddle", "logic"],
  dices: ["board games", "chance", "random", "dnd"],
  ticket: ["tickets", "concert", "concerts", "show", "theater"],
  star: ["favorite", "favorites", "review", "reviews", "rating"],
  rocket: ["launch", "ship", "build", "builder", "growth hacking", "space"],
  zap: ["fast", "quick", "energy", "power", "electric"],
  flame: ["motivation", "streak", "hot", "trending"],
  sun: ["weather", "day", "summer", "sunny"],
  clock: ["time", "timer", "reminder", "reminders", "deadline", "deadlines"],
  bell: ["alert", "alerts", "notify", "notifications", "watch", "monitor", "monitoring"],
  eye: ["watcher", "observe", "tracking", "track"],
  "shield-check": ["verify", "verification", "review", "approval", "quality"],
  "folder-open": ["files", "folder", "organize", "storage", "drive"],
  "table-2": ["spreadsheet", "sheets", "excel", "table", "csv"],
  calculator: ["math", "calculate", "numbers", "estimate", "accounting math"],
  "badge-dollar-sign": ["pricing", "price", "revenue", "deal hunting", "discount"],
  church: ["faith", "religion", "spiritual", "church"],
  anchor: ["boat", "sailing", "sea", "harbor"],
  fish: ["fishing", "aquarium", "fish"],
  "tree-pine": ["nature", "forest", "trees"],
  hammer: ["diy", "renovation", "build", "construction", "handyman"],
  shirt: ["fashion", "clothes", "style", "outfit", "wardrobe"],
  scissors: ["hair", "crafts", "cut", "trim"],
  wine: ["wine", "drinks", "bar", "cocktails"],
};

export const AGENT_ICON_NAMES = Object.keys(AGENT_ICONS);

const ICON_SET = new Set(AGENT_ICON_NAMES);

export function isAgentIcon(name: unknown): name is string {
  return typeof name === "string" && ICON_SET.has(name);
}

/** A known icon name from loose input ("Rocket ", "rocket"), or null. */
export function normalizeAgentIcon(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const icon = name.trim().toLowerCase();
  return ICON_SET.has(icon) ? icon : null;
}

/**
 * The agent's own pick when it is a known icon, otherwise the icon whose
 * keywords best match its name and description. Name matches count double, so
 * "Finance coach" lands on the wallet rather than the dumbbell.
 */
export function agentIcon(input: {
  icon?: string | null | undefined;
  name?: string | null | undefined;
  description?: string | null | undefined;
}): string | null {
  const picked = input.icon?.trim().toLowerCase();
  if (picked && ICON_SET.has(picked)) return picked;
  const name = words(input.name);
  const description = words(input.description);
  if (!name && !description) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const [icon, keywords] of Object.entries(AGENT_ICONS)) {
    let score = 0;
    for (const keyword of [icon.replace(/-/g, " "), ...keywords]) {
      const needle = ` ${keyword} `;
      if (name.includes(needle)) score += 2 * keyword.length;
      if (description.includes(needle)) score += keyword.length;
    }
    if (score > bestScore) {
      best = icon;
      bestScore = score;
    }
  }
  return best;
}

function words(text: string | null | undefined) {
  if (!text) return "";
  const tokens = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    // "Meals" should match "meal": add each plural's singular next to it.
    .flatMap((word) =>
      word.length > 3 && word.endsWith("s") ? [word, word.slice(0, -1)] : [word],
    );
  return tokens.length ? ` ${tokens.join(" ")} ` : "";
}
