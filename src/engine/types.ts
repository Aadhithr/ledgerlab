// Core data model for the simulated Bill Pay world.
// All money is integer cents. All times are simulated epoch milliseconds.

export type Cents = number;
export type SimTime = number;

export interface Vendor {
  id: string;
  name: string;
  bankAccount: string;
  /** Set when bank details change; payments to an unverified account are risky. */
  bankVerified: boolean;
  bankChangedAt?: SimTime;
  previousBankAccount?: string;
}

export interface Attachment {
  id: string;
  kind: "invoice" | "receipt" | "po";
  filename: string;
  /** Content fingerprint. Two attachments with the same hash are the same document. */
  hash: string;
}

export type BillStatus = "pending_approval" | "approved" | "rejected" | "paid" | "void";

export interface Bill {
  id: string;
  vendorId: string;
  invoiceNumber: string;
  amount: Cents;
  dueAt: SimTime;
  createdAt: SimTime;
  status: BillStatus;
  approvals: Approval[];
  requiredApprovals: number;
  attachments: Attachment[];
  memo: string;
  flagged?: { reason: string; at: SimTime };
  syncedToAccounting: boolean;
}

export interface Approval {
  by: string;
  role: "human" | "agent";
  at: SimTime;
}

export type PaymentStatus = "processing" | "settled" | "failed" | "cancelled";

export interface Payment {
  id: string;
  billId: string;
  vendorId: string;
  amount: Cents;
  toAccount: string;
  status: PaymentStatus;
  createdAt: SimTime;
  settledAt?: SimTime;
  idempotencyKey?: string;
}

export interface Refund {
  id: string;
  paymentId: string;
  amount: Cents;
  reason: string;
  createdAt: SimTime;
}

export interface LedgerEntry {
  id: string;
  billId: string;
  paymentId?: string;
  debitAccount: string;
  creditAccount: string;
  amount: Cents;
  memo: string;
  postedAt: SimTime;
}

export interface InboxMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  at: SimTime;
  kind: "email" | "notification";
}

export interface Policy {
  /** Bills above this need human approval before payment. */
  approvalThreshold: Cents;
  /** The agent may approve bills at or below this amount itself. */
  agentApprovalLimit: Cents;
  /** Bills above this need an attached invoice before payment. */
  evidenceThreshold: Cents;
}

/** Fault switches the chaos controller can arm. Tools consult them. */
export interface Faults {
  /** Next N pay_bill calls report a timeout although the payment went through. */
  paymentTimeouts: number;
  /** Next N accounting syncs fail. */
  syncFailures: number;
  /** Extra hours added before settlement notifications arrive. */
  notificationDelayHours: number;
}

export interface ScheduledEvent {
  at: SimTime;
  event: EventInput;
}

export interface WorldState {
  company: string;
  now: SimTime;
  policy: Policy;
  vendors: Record<string, Vendor>;
  bills: Record<string, Bill>;
  payments: Record<string, Payment>;
  refunds: Record<string, Refund>;
  ledger: LedgerEntry[];
  inbox: InboxMessage[];
  faults: Faults;
  scheduled: ScheduledEvent[];
  report?: AgentReport;
}

export interface AgentReport {
  summary: string;
  paid: { bill_id: string; amount_cents: number; payment_id?: string }[];
  escalated: { bill_id: string; reason: string }[];
  refunds: { payment_id: string; amount_cents: number }[];
  synced: string[];
  submittedAt: SimTime;
}

export type Actor = "system" | "agent" | "chaos" | "clock" | "user";

/** Every change to the world is one of these. The log is the source of truth. */
export type EventInput =
  | { type: "seed"; data: { state: WorldState } }
  | { type: "clock.advanced"; data: { to: SimTime; reason: string } }
  | { type: "bill.created"; data: { bill: Bill } }
  | { type: "bill.approved"; data: { billId: string; approval: Approval } }
  | { type: "bill.status"; data: { billId: string; status: BillStatus } }
  | { type: "bill.flagged"; data: { billId: string; reason: string } }
  | { type: "bill.attachment_removed"; data: { billId: string; attachmentId: string } }
  | { type: "bill.synced"; data: { billId: string } }
  | { type: "vendor.bank_changed"; data: { vendorId: string; account: string; verified: boolean } }
  | { type: "payment.created"; data: { payment: Payment } }
  | { type: "payment.status"; data: { paymentId: string; status: PaymentStatus } }
  | { type: "refund.created"; data: { refund: Refund } }
  | { type: "ledger.posted"; data: { entry: LedgerEntry } }
  | { type: "inbox.received"; data: { message: InboxMessage } }
  | { type: "faults.set"; data: Partial<Faults> }
  | { type: "schedule.added"; data: ScheduledEvent }
  | { type: "agent.tool_call"; data: { tool: string; input: unknown; output: string; isError: boolean } }
  | { type: "agent.message"; data: { text: string } }
  | { type: "agent.report"; data: { report: AgentReport } }
  | { type: "chaos.injected"; data: { kind: string; label: string; params?: Record<string, unknown>; bills?: string[] } }
  | { type: "run.note"; data: { text: string } };

export type WorldEvent = EventInput & { seq: number; at: SimTime; actor: Actor };

export const fmtUsd = (c: Cents) =>
  (c < 0 ? "-$" : "$") + (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
