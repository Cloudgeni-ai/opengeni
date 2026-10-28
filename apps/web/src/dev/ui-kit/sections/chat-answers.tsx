import { useCallback, useMemo, useState } from "react";
import { InteractiveAnswerProvider, Markdown, MessageTimeline } from "@opengeni/react";
import type { InteractiveAnswerStore } from "@opengeni/react";
import type { SessionEvent } from "@opengeni/sdk";
import { KitBlock, KitSection, StateCell, StatesGrid } from "../kit";
import { kitEvent, showPart } from "./chat-shared";

/* ----------------------------------------------------------------------------
   Interactive answers: an agent's `opengeni-ui` fence drawn as linked cards,
   a table and a bar chart, with a pick that goes back into the chat as the
   person's next message. Rendered by the real timeline.
   -------------------------------------------------------------------------- */

const fence = (body: unknown) => "```opengeni-ui\n" + JSON.stringify(body, null, 2) + "\n```";

const LAPTOPS = {
  title: "Light laptops for travel",
  fields: [
    { key: "price", label: "Price", unit: "kr", better: "lower" },
    { key: "weight", label: "Weight", unit: "kg", better: "lower" },
    { key: "battery", label: "Battery", unit: "h", better: "higher" },
    { key: "os", label: "System", filter: true },
  ],
  chart: "price",
  select: { max: 3, action: "Compare these in detail" },
  items: [
    {
      id: "air",
      title: "MacBook Air 13 (M4)",
      subtitle: "16 GB · 512 GB",
      badge: "Recommended",
      description: "The best balance of weight, battery and price. Silent, no fan.",
      url: "https://www.apple.com/no/macbook-air/",
      values: { price: 13990, weight: 1.24, battery: 18, os: "macOS" },
    },
    {
      id: "x1",
      title: "ThinkPad X1 Carbon Gen 13",
      subtitle: "32 GB · 1 TB",
      badge: "Lightest",
      description: "Under a kilo with a great keyboard, but the priciest here.",
      values: { price: 19990, weight: 0.99, battery: 15, os: "Windows" },
    },
    {
      id: "zenbook",
      title: "ASUS Zenbook S 14",
      subtitle: "32 GB · 1 TB",
      description: "OLED screen and long battery life for the price.",
      values: { price: 14990, weight: 1.2, battery: 16, os: "Windows" },
    },
    {
      id: "xps",
      title: "Dell XPS 13",
      subtitle: "16 GB · 512 GB",
      description: "Compact and well built; the battery is a little shorter.",
      values: { price: 16490, weight: 1.19, battery: 14, os: "Windows" },
    },
    {
      id: "framework",
      title: "Framework Laptop 13",
      subtitle: "32 GB · 1 TB",
      description: "Repairable and upgradeable, and the cheapest of the six.",
      values: { price: 12490, weight: 1.3, battery: 10, os: "Linux" },
    },
    {
      id: "omnibook",
      title: "HP OmniBook Ultra Flip 14",
      subtitle: "32 GB · 1 TB",
      description: "Folds into a tablet; the heaviest of these.",
      values: { price: 17990, weight: 1.34, battery: 12, os: "Windows" },
    },
  ],
};

const FLIGHTS = {
  title: "Oslo to Lisbon, Friday 13 November",
  view: "table",
  fields: [
    { key: "depart", label: "Departs" },
    { key: "arrive", label: "Arrives" },
    { key: "duration", label: "Duration", unit: "h", better: "lower" },
    { key: "stops", label: "Stops", filter: true },
    { key: "price", label: "Price", unit: "kr", better: "lower" },
  ],
  select: { max: 1, action: "Book this flight" },
  items: [
    {
      id: "tp",
      title: "TAP",
      subtitle: "TP 755",
      values: { depart: "10:35", arrive: "13:25", duration: 3.8, stops: "Direct", price: 2140 },
    },
    {
      id: "dy",
      title: "Norwegian",
      subtitle: "DY 1300",
      badge: "Cheapest",
      values: { depart: "07:00", arrive: "09:55", duration: 3.9, stops: "Direct", price: 1690 },
    },
    {
      id: "kl",
      title: "KLM",
      subtitle: "KL 1144 · KL 1695",
      values: { depart: "06:10", arrive: "11:40", duration: 6.5, stops: "1 stop", price: 1980 },
    },
    {
      id: "lh",
      title: "Lufthansa",
      subtitle: "LH 869 · LH 1166",
      values: { depart: "11:45", arrive: "18:20", duration: 7.6, stops: "1 stop", price: 2390 },
    },
  ],
};

const SLOTS = {
  select: { max: 1, action: "Book this time" },
  items: [
    { id: "tue", title: "Tuesday 3 November, 10:00–10:45", subtitle: "Everyone is free" },
    {
      id: "wed",
      title: "Wednesday 4 November, 14:00–14:45",
      subtitle: "Kari joins from the train",
    },
    { id: "thu", title: "Thursday 5 November, 09:00–09:45", subtitle: "Room 4 is free" },
  ],
};

const LAPTOP_MESSAGE = `I found six laptops under 20 000 kr that weigh about a kilo. The MacBook Air is the best all-rounder; the ThinkPad is the lightest.\n\n${fence(LAPTOPS)}\n\nPick the ones you'd like me to look at more closely.`;

/** A store that forgets on reload, so the kit always starts the same way. */
function memoryStore(seed: Record<string, string> = {}): InteractiveAnswerStore {
  const values = new Map(Object.entries(seed));
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
  };
}

function AnswerChat({
  user,
  agent,
  height = 1300,
  phoneHeight = 2600,
  scope,
}: {
  user: string;
  agent: string;
  height?: number;
  phoneHeight?: number;
  scope: string;
}) {
  const narrow = typeof window !== "undefined" && window.innerWidth < 600;
  const [sent, setSent] = useState<SessionEvent[]>([]);
  const base = useMemo(
    () => [
      kitEvent("user.message", { text: user }),
      kitEvent("agent.message.completed", { text: agent }),
    ],
    [agent, user],
  );
  const store = useMemo(() => memoryStore(), []);
  const send = useCallback(async (text: string) => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    setSent((current) => [...current, kitEvent("user.message", { text })]);
    return true;
  }, []);
  return (
    <div
      className="flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-border bg-bg"
      style={{ height: narrow ? phoneHeight : height }}
    >
      <InteractiveAnswerProvider send={send} scope={scope} store={store}>
        <MessageTimeline className="h-full" events={[...base, ...sent]} status={"idle" as never} />
      </InteractiveAnswerProvider>
    </div>
  );
}

function Body({
  text,
  streaming,
  store,
  send = true,
}: {
  text: string;
  streaming?: boolean;
  store?: InteractiveAnswerStore;
  send?: boolean;
}) {
  return (
    <InteractiveAnswerProvider
      send={send ? async () => true : undefined}
      scope="kit-state"
      store={store}
    >
      <div className="w-full min-w-0 text-left">
        <Markdown softLineBreaks streaming={streaming}>
          {text}
        </Markdown>
      </div>
    </InteractiveAnswerProvider>
  );
}

const SENT_STATE = JSON.stringify({
  selected: ["dy"],
  sent: ["dy"],
  view: null,
  sort: null,
  filters: {},
});

export default function ChatAnswersSection() {
  const flights = fence(FLIGHTS);
  const partial = fence(LAPTOPS);
  const streamingText = partial.slice(0, partial.indexOf('"id": "xps"') + 40);
  const sentStore = useMemo(() => {
    // The key matches what the answer derives from its body.
    return {
      get: (key: string) => (key.startsWith("og:answer:kit-state:") ? SENT_STATE : null),
      set: () => undefined,
    } satisfies InteractiveAnswerStore;
  }, []);
  return (
    <KitSection sectionKey="chat-answers">
      {showPart("compare") ? (
        <KitBlock
          title="Compare and pick"
          description="Cards, a chart and filters share one selection. The pick goes back into the chat as the person's message."
        >
          <AnswerChat
            scope="kit-compare"
            user="Find me a light laptop for travel, under 20 000 kr. I'd like to compare a few."
            agent={LAPTOP_MESSAGE}
          />
        </KitBlock>
      ) : null}
      {showPart("table") ? (
        <KitBlock
          title="Table, one pick"
          description="Sortable columns, a filter, and the best value in each column marked."
        >
          <AnswerChat
            scope="kit-table"
            height={760}
            phoneHeight={1300}
            user="Find flights from Oslo to Lisbon on Friday the 13th."
            agent={`Four options that day. Norwegian is the cheapest direct flight.\n\n${flights}`}
          />
        </KitBlock>
      ) : null}
      {showPart("states") ? (
        <StatesGrid title="States" columns={2}>
          <StateCell label="Simple choice, no fields" align="stretch">
            <Body text={`Three times work for everyone.\n\n${fence(SLOTS)}`} />
          </StateCell>
          <StateCell label="Sent" align="stretch">
            <Body text={flights} store={sentStore} />
          </StateCell>
          <StateCell label="Still being written" align="stretch">
            <Body text={streamingText} streaming />
          </StateCell>
          <StateCell label="Without a send action (read-only host)" align="stretch">
            <Body text={fence({ ...SLOTS, title: "Times that work" })} send={false} />
          </StateCell>
          <StateCell label="Body that can't be read" align="stretch">
            <Body text={'```opengeni-ui\n{ "items": [ oops ] }\n```'} />
          </StateCell>
          <StateCell label="Stopped before it finished" align="stretch">
            <Body text={streamingText} />
          </StateCell>
        </StatesGrid>
      ) : null}
    </KitSection>
  );
}
