export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketStatus = "open" | "investigating" | "waiting_on_customer" | "resolved";

export type SupportNote = {
  id: string;
  author: string;
  authorKind: "human" | "agent";
  body: string;
  createdAt: string;
};

export type SupportActivity = {
  id: string;
  actor: string;
  summary: string;
  createdAt: string;
};

export type SupportCustomer = {
  id: string;
  name: string;
  initials: string;
  plan: string;
  arr: number;
  healthScore: number;
  joinedAt: string;
  primaryContact: {
    name: string;
    role: string;
    email: string;
  };
  recentUsage: {
    activeSeats: number;
    totalSeats: number;
    exportsLast30Days: number;
    failedExportsLast7Days: number;
  };
};

export type SupportTicket = {
  id: string;
  customerId: string;
  subject: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignee: string;
  channel: "email";
  createdAt: string;
  slaDueAt: string;
  tags: string[];
  notes: SupportNote[];
  activity: SupportActivity[];
};

export type SupportDemoState = {
  revision: number;
  ticket: SupportTicket;
  customer: SupportCustomer;
};

export type SupportDomainEvent = {
  id: string;
  type: "ticket.updated" | "ticket.note_added" | "demo.reset";
  revision: number;
  summary: string;
  occurredAt: string;
};

export type DemoHealth = {
  ok: boolean;
  workspaceId: string | null;
  openGeniConfigured: boolean;
  mcpTokenConfigured: boolean;
  mcpPublicUrl: string | null;
};
