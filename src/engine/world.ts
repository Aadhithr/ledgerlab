import type { Actor, EventInput, WorldEvent, WorldState, SimTime } from "./types.js";

/** Pure reducer: applies one event to a state in place. Replaying the log reproduces any past state. */
export function applyEvent(s: WorldState, ev: EventInput): void {
  switch (ev.type) {
    case "seed":
      Object.assign(s, structuredClone(ev.data.state));
      return;
    case "clock.advanced":
      s.now = ev.data.to;
      s.scheduled = s.scheduled.filter((x) => x.at > ev.data.to);
      return;
    case "bill.created":
      s.bills[ev.data.bill.id] = structuredClone(ev.data.bill);
      return;
    case "bill.approved": {
      const b = s.bills[ev.data.billId];
      if (!b) return;
      b.approvals.push(ev.data.approval);
      if (b.status === "pending_approval" && b.approvals.length >= b.requiredApprovals) b.status = "approved";
      return;
    }
    case "bill.status":
      if (s.bills[ev.data.billId]) s.bills[ev.data.billId].status = ev.data.status;
      return;
    case "bill.flagged":
      if (s.bills[ev.data.billId]) s.bills[ev.data.billId].flagged = { reason: ev.data.reason, at: s.now };
      return;
    case "bill.attachment_removed": {
      const b = s.bills[ev.data.billId];
      if (b) b.attachments = b.attachments.filter((a) => a.id !== ev.data.attachmentId);
      return;
    }
    case "bill.synced":
      if (s.bills[ev.data.billId]) s.bills[ev.data.billId].syncedToAccounting = true;
      return;
    case "vendor.bank_changed": {
      const v = s.vendors[ev.data.vendorId];
      if (!v) return;
      v.previousBankAccount = v.bankAccount;
      v.bankAccount = ev.data.account;
      v.bankVerified = ev.data.verified;
      v.bankChangedAt = s.now;
      return;
    }
    case "payment.created":
      s.payments[ev.data.payment.id] = structuredClone(ev.data.payment);
      return;
    case "payment.status": {
      const p = s.payments[ev.data.paymentId];
      if (!p) return;
      p.status = ev.data.status;
      if (ev.data.status === "settled") p.settledAt = s.now;
      return;
    }
    case "refund.created":
      s.refunds[ev.data.refund.id] = structuredClone(ev.data.refund);
      return;
    case "ledger.posted":
      s.ledger.push(structuredClone(ev.data.entry));
      return;
    case "inbox.received":
      s.inbox.push(structuredClone(ev.data.message));
      return;
    case "faults.set":
      Object.assign(s.faults, ev.data);
      return;
    case "schedule.added":
      s.scheduled.push(structuredClone(ev.data));
      s.scheduled.sort((a, b) => a.at - b.at);
      return;
    case "agent.report":
      s.report = structuredClone(ev.data.report);
      return;
    // Informational events do not change state.
    case "agent.tool_call":
    case "agent.message":
    case "chaos.injected":
    case "run.note":
      return;
  }
}

export function emptyState(): WorldState {
  return {
    company: "",
    now: 0,
    policy: { approvalThreshold: 0, agentApprovalLimit: 0, evidenceThreshold: 0 },
    vendors: {},
    bills: {},
    payments: {},
    refunds: {},
    ledger: [],
    inbox: [],
    faults: { paymentTimeouts: 0, syncFailures: 0, notificationDelayHours: 0 },
    scheduled: [],
  };
}

/** Rebuild the state as it was right after event `seq` (inclusive). */
export function stateAt(events: WorldEvent[], seq: number): WorldState {
  const s = emptyState();
  for (const ev of events) {
    if (ev.seq > seq) break;
    applyEvent(s, ev);
  }
  return s;
}

export type WorldListener = (ev: WorldEvent) => void;

/** An event-sourced world. Every mutation goes through emit(). */
export class World {
  readonly events: WorldEvent[] = [];
  readonly state: WorldState = emptyState();
  private counters: Record<string, number> = {};
  private listeners: WorldListener[] = [];

  constructor(seed: WorldState) {
    this.emit("system", { type: "seed", data: { state: seed } });
    for (const b of Object.values(seed.bills)) this.bump("bill", b.id);
    for (const p of Object.values(seed.payments)) this.bump("pay", p.id);
  }

  onEvent(fn: WorldListener): () => void {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((l) => l !== fn));
  }

  emit(actor: Actor, input: EventInput): WorldEvent {
    const ev = { ...input, seq: this.events.length, at: this.state.now, actor } as WorldEvent;
    applyEvent(this.state, input);
    this.events.push(ev);
    for (const l of this.listeners) l(ev);
    return ev;
  }

  /** Deterministic ids so replays and saved scenarios line up. */
  nextId(prefix: string): string {
    this.counters[prefix] = (this.counters[prefix] ?? 0) + 1;
    return `${prefix}_${String(this.counters[prefix]).padStart(3, "0")}`;
  }

  private bump(prefix: string, id: string) {
    const n = Number(id.split("_").pop());
    if (Number.isFinite(n)) this.counters[prefix] = Math.max(this.counters[prefix] ?? 0, n);
  }

  schedule(at: SimTime, event: EventInput) {
    this.emit("system", { type: "schedule.added", data: { at, event } });
  }

  /** Move simulated time forward, firing every scheduled event that comes due, in order. */
  advanceTo(target: SimTime, reason: string, actor: Actor = "clock") {
    if (target <= this.state.now) return;
    for (;;) {
      const next = this.state.scheduled[0];
      if (!next || next.at > target) break;
      const due = this.state.scheduled.filter((x) => x.at <= next.at);
      this.emit(actor, { type: "clock.advanced", data: { to: next.at, reason } });
      for (const d of due) this.emit("system", d.event);
    }
    this.emit(actor, { type: "clock.advanced", data: { to: target, reason } });
  }

  advanceBy(ms: number, reason: string, actor: Actor = "clock") {
    this.advanceTo(this.state.now + ms, reason, actor);
  }
}
