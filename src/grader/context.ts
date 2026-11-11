import { stateAt } from "../engine/world.js";
import type { AgentReport, Bill, Payment, WorldEvent, WorldState } from "../engine/types.js";
import type { Expectations } from "../scenarios/library.js";

export interface Finding {
  message: string;
  /** Event sequence numbers that prove the finding. */
  seqs: number[];
  /** Money that would have been lost or put at risk, in cents. */
  dollars: number;
}

export type Severity = "critical" | "high" | "medium";

export interface GradeContext {
  events: WorldEvent[];
  final: WorldState;
  report?: AgentReport;
  expect: Expectations;
  /** payment id -> seq of its payment.created event, for payments made during the run. */
  runPayments: Map<string, number>;
  /** bill ids that the chaos controller created. */
  chaosBills: Set<string>;
  /** bill ids an injected exception put in question (created, altered, or targeted). */
  chaosTouched: Set<string>;
  /** Cached snapshot just before an event. */
  before: (seq: number) => WorldState;
}

export const isActive = (p: Payment) => p.status === "processing" || p.status === "settled";

export function buildContext(events: WorldEvent[], expect: Expectations): GradeContext {
  const final = stateAt(events, Number.MAX_SAFE_INTEGER);
  const runPayments = new Map<string, number>();
  const chaosBills = new Set<string>();
  const chaosTouched = new Set<string>();
  for (const ev of events) {
    if (ev.type === "payment.created") runPayments.set(ev.data.payment.id, ev.seq);
    if (ev.type === "bill.created" && (ev.actor === "chaos" || ev.actor === "user")) chaosBills.add(ev.data.bill.id);
    if (ev.type === "chaos.injected") for (const b of ev.data.bills ?? []) chaosTouched.add(b);
  }
  const cache = new Map<number, WorldState>();
  return {
    events,
    final,
    report: final.report,
    expect,
    runPayments,
    chaosBills,
    chaosTouched,
    before: (seq) => {
      if (!cache.has(seq)) cache.set(seq, stateAt(events, seq - 1));
      return cache.get(seq)!;
    },
  };
}

export function activeRunPayments(ctx: GradeContext): Payment[] {
  return Object.values(ctx.final.payments).filter((p) => ctx.runPayments.has(p.id) && isActive(p));
}

export function paymentsForBill(ctx: GradeContext, billId: string, runOnly = false): Payment[] {
  return Object.values(ctx.final.payments).filter((p) => p.billId === billId && isActive(p) && (!runOnly || ctx.runPayments.has(p.id)));
}

export function billLabel(ctx: GradeContext, b: Bill | string): string {
  const bill = typeof b === "string" ? ctx.final.bills[b] : b;
  if (!bill) return String(b);
  return `${bill.id} (${ctx.final.vendors[bill.vendorId]?.name ?? bill.vendorId} ${bill.invoiceNumber})`;
}

export function seqsWhere(ctx: GradeContext, pred: (ev: WorldEvent) => boolean): number[] {
  return ctx.events.filter(pred).map((e) => e.seq);
}

export const usd = (c: number) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
