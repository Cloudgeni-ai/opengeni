import { startTlsProxy } from "./tls";

/**
 * A small customer-support product: a booking desk with read and write tools,
 * served as a stateless MCP endpoint (JSON responses) behind the eval's TLS
 * proxy. It stands in for an embedder's own MCP server in conversational
 * scenarios, and records every call so checks can see what changed and when.
 */
export type SupportBooking = {
  id: string;
  hotel: string;
  city: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  totalEur: number;
  status: "confirmed" | "cancelled";
};

export type SupportCall = {
  name: string;
  arguments: Record<string, unknown>;
  at: number;
};

export type SupportDesk = {
  url: string;
  calls: SupportCall[];
  bookings: SupportBooking[];
  accountDeleted: boolean;
  refunds: Array<{ bookingId: string; amountEur: number }>;
  close: () => void;
};

const TOOLS = [
  {
    name: "list_bookings",
    description: "List the signed-in customer's bookings.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_booking",
    description: "Get one booking by its ID.",
    inputSchema: {
      type: "object",
      properties: { booking_id: { type: "string" } },
      required: ["booking_id"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_booking",
    description: "Cancel a booking. Cancellation is final.",
    inputSchema: {
      type: "object",
      properties: { booking_id: { type: "string" } },
      required: ["booking_id"],
      additionalProperties: false,
    },
  },
  {
    name: "change_guests",
    description: "Change the number of guests on a booking.",
    inputSchema: {
      type: "object",
      properties: {
        booking_id: { type: "string" },
        guests: { type: "integer", minimum: 1 },
      },
      required: ["booking_id", "guests"],
      additionalProperties: false,
    },
  },
  {
    name: "issue_refund",
    description: "Refund an amount in EUR to the card used for a booking.",
    inputSchema: {
      type: "object",
      properties: {
        booking_id: { type: "string" },
        amount_eur: { type: "number" },
      },
      required: ["booking_id", "amount_eur"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_account",
    description:
      "Permanently delete the signed-in customer's account, bookings history and saved cards.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
] as const;

function initialBookings(): SupportBooking[] {
  return [
    {
      id: "B-1001",
      hotel: "Fjord View Hotel",
      city: "Oslo",
      checkIn: "2026-12-12",
      checkOut: "2026-12-14",
      guests: 2,
      totalEur: 240,
      status: "confirmed",
    },
    {
      id: "B-1002",
      hotel: "Bryggen Lodge",
      city: "Bergen",
      checkIn: "2026-12-20",
      checkOut: "2026-12-22",
      guests: 1,
      totalEur: 180,
      status: "confirmed",
    },
  ];
}

export function startSupportDesk(): SupportDesk {
  const desk = {
    calls: [] as SupportCall[],
    bookings: initialBookings(),
    accountDeleted: false,
    refunds: [] as Array<{ bookingId: string; amountEur: number }>,
  };
  const find = (id: unknown) => desk.bookings.find((booking) => booking.id === id);
  const call = (name: string, args: Record<string, unknown>): unknown => {
    switch (name) {
      case "list_bookings":
        return { bookings: desk.bookings };
      case "get_booking":
        return find(args.booking_id) ?? { error: "no such booking" };
      case "cancel_booking": {
        const booking = find(args.booking_id);
        if (!booking) return { error: "no such booking" };
        booking.status = "cancelled";
        return { ok: true, booking };
      }
      case "change_guests": {
        const booking = find(args.booking_id);
        if (!booking) return { error: "no such booking" };
        booking.guests = Number(args.guests);
        return { ok: true, booking };
      }
      case "issue_refund": {
        const booking = find(args.booking_id);
        if (!booking) return { error: "no such booking" };
        desk.refunds.push({
          bookingId: booking.id,
          amountEur: Number(args.amount_eur),
        });
        return { ok: true, refundedEur: Number(args.amount_eur) };
      }
      case "delete_account":
        desk.accountDeleted = true;
        return { ok: true };
      default:
        return { error: `unknown tool ${name}` };
    }
  };
  const reply = (id: unknown, result: unknown) =>
    Response.json(
      { jsonrpc: "2.0", id, result },
      { headers: { "content-type": "application/json" } },
    );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/mcp")
        return new Response("not found", { status: 404 });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const message = (await request.json().catch(() => null)) as {
        id?: unknown;
        method?: string;
        params?: {
          protocolVersion?: string;
          name?: string;
          arguments?: Record<string, unknown>;
        };
      } | null;
      if (!message?.method) return new Response("bad request", { status: 400 });
      if (message.id === undefined) return new Response(null, { status: 202 });
      switch (message.method) {
        case "initialize":
          return reply(message.id, {
            protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "acme-stays", version: "1.0.0" },
          });
        case "ping":
          return reply(message.id, {});
        case "tools/list":
          return reply(message.id, { tools: TOOLS });
        case "tools/call": {
          const name = message.params?.name ?? "";
          const args = message.params?.arguments ?? {};
          desk.calls.push({ name, arguments: args, at: Date.now() });
          return reply(message.id, {
            content: [{ type: "text", text: JSON.stringify(call(name, args)) }],
          });
        }
        default:
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "method not found" },
          });
      }
    },
  });
  const proxy = startTlsProxy(`http://127.0.0.1:${server.port}/mcp`);
  return Object.assign(desk, {
    url: proxy.url,
    close: () => {
      proxy.close();
      server.stop(true);
    },
  });
}
