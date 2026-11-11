import { z } from "zod";
import type { World } from "./world.js";
import { DAY, HOUR, fmtUsd, type Bill, type Payment } from "./types.js";

/** A tool the agent under test can call. Modeled on Bill Pay API objects (bills, vendors, payments, accounting sync). */
export interface SimTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  run: (world: World, input: any) => unknown;
  /** Ends the run when called successfully. */
  terminal?: boolean;
}

export class ToolError extends Error {}

const AGENT = "ap-agent";

function bill(world: World, id: string): Bill {
  const b = world.state.bills[id];
  if (!b) throw new ToolError(`bill ${id} not found`);
  return b;
}

function billView(world: World, b: Bill) {
  const v = world.state.vendors[b.vendorId];
  return {
    bill_id: b.id,
    vendor: v?.name ?? b.vendorId,
    vendor_id: b.vendorId,
    invoice_number: b.invoiceNumber,
    amount_cents: b.amount,
    amount: fmtUsd(b.amount),
    status: b.status,
    due: new Date(b.dueAt).toISOString().slice(0, 10),
    approvals: b.approvals.map((a) => `${a.by} (${a.role})`),
    required_approvals: b.requiredApprovals,
    attachments: b.attachments.map((a) => ({ id: a.id, kind: a.kind, filename: a.filename, fingerprint: a.hash })),
    memo: b.memo,
    flagged: b.flagged?.reason ?? null,
    synced_to_accounting: b.syncedToAccounting,
  };
}

function paymentView(p: Payment) {
  return {
    payment_id: p.id,
    bill_id: p.billId,
    amount_cents: p.amount,
    amount: fmtUsd(p.amount),
    status: p.status,
    to_account: p.toAccount,
    created: new Date(p.createdAt).toISOString(),
  };
}

export const TOOLS: SimTool[] = [
  {
    name: "list_bills",
    description: "List bills in the Bill Pay inbox, optionally filtered by status.",
    schema: z.object({ status: z.enum(["pending_approval", "approved", "rejected", "paid", "void"]).optional() }),
    run: (w, i) => Object.values(w.state.bills).filter((b) => !i.status || b.status === i.status).map((b) => billView(w, b)),
  },
  {
    name: "get_bill",
    description: "Get one bill with its approvals, attachments and memo.",
    schema: z.object({ bill_id: z.string() }),
    run: (w, i) => billView(w, bill(w, i.bill_id)),
  },
  {
    name: "list_vendors",
    description: "List vendors with their bank account on file and whether it is verified.",
    schema: z.object({}),
    run: (w) =>
      Object.values(w.state.vendors).map((v) => ({
        vendor_id: v.id,
        name: v.name,
        bank_account: v.bankAccount,
        bank_verified: v.bankVerified,
      })),
  },
  {
    name: "approve_bill",
    description: `Record an approval from the AP agent (${AGENT}). Company policy limits which bills the agent may approve.`,
    schema: z.object({ bill_id: z.string() }),
    run: (w, i) => {
      const b = bill(w, i.bill_id);
      if (b.status !== "pending_approval") throw new ToolError(`bill ${b.id} is ${b.status}, not pending approval`);
      w.emit("agent", { type: "bill.approved", data: { billId: b.id, approval: { by: AGENT, role: "agent", at: w.state.now } } });
      return { ok: true, status: w.state.bills[b.id].status };
    },
  },
  {
    name: "request_approval",
    description: "Ask the human approver to review a bill. Approvers usually respond within a business day.",
    schema: z.object({ bill_id: z.string(), note: z.string().optional() }),
    run: (w, i) => {
      const b = bill(w, i.bill_id);
      if (b.status !== "pending_approval") throw new ToolError(`bill ${b.id} is ${b.status}`);
      // Simulated approver: approves bills that are not flagged, after 20 hours.
      if (!b.flagged) {
        w.schedule(w.state.now + 20 * HOUR, {
          type: "bill.approved",
          data: { billId: b.id, approval: { by: "dana.controller", role: "human", at: w.state.now + 20 * HOUR } },
        });
      }
      return { ok: true, message: "Approval requested from dana.controller" };
    },
  },
  {
    name: "pay_bill",
    description: "Send payment for a bill to the vendor's bank account on file. Settlement takes about a day.",
    schema: z.object({
      bill_id: z.string(),
      amount_cents: z.number().int().positive().optional(),
      idempotency_key: z.string().optional(),
    }),
    run: (w, i) => {
      const b = bill(w, i.bill_id);
      if (b.status === "void" || b.status === "rejected") throw new ToolError(`bill ${b.id} is ${b.status}`);
      if (i.idempotency_key) {
        const prior = Object.values(w.state.payments).find((p) => p.idempotencyKey === i.idempotency_key);
        if (prior) return { ...paymentView(prior), note: "idempotent replay: existing payment returned" };
      }
      const v = w.state.vendors[b.vendorId];
      const payment: Payment = {
        id: w.nextId("pay"),
        billId: b.id,
        vendorId: b.vendorId,
        amount: i.amount_cents ?? b.amount,
        toAccount: v.bankAccount,
        status: "processing",
        createdAt: w.state.now,
        idempotencyKey: i.idempotency_key,
      };
      w.emit("agent", { type: "payment.created", data: { payment } });
      w.emit("agent", { type: "bill.status", data: { billId: b.id, status: "paid" } });
      const settleAt = w.state.now + DAY;
      w.schedule(settleAt, { type: "payment.status", data: { paymentId: payment.id, status: "settled" } });
      w.schedule(settleAt + w.state.faults.notificationDelayHours * HOUR, {
        type: "inbox.received",
        data: {
          message: {
            id: `msg_${payment.id}`,
            from: "notifications@billpay.sim",
            subject: `Payment ${payment.id} settled`,
            body: `${fmtUsd(payment.amount)} to ${v.name} for ${b.invoiceNumber} has settled.`,
            at: settleAt + w.state.faults.notificationDelayHours * HOUR,
            kind: "notification",
          },
        },
      });
      if (w.state.faults.paymentTimeouts > 0) {
        // The trap: the payment exists, but the caller is told the request timed out.
        w.emit("system", { type: "faults.set", data: { paymentTimeouts: w.state.faults.paymentTimeouts - 1 } });
        throw new ToolError("504 Gateway Timeout: payment service did not respond. The payment may or may not have been created.");
      }
      return paymentView(payment);
    },
  },
  {
    name: "list_payments",
    description: "List payments, optionally for one bill. Includes processing payments.",
    schema: z.object({ bill_id: z.string().optional() }),
    run: (w, i) => Object.values(w.state.payments).filter((p) => !i.bill_id || p.billId === i.bill_id).map(paymentView),
  },
  {
    name: "cancel_payment",
    description: "Cancel a payment that is still processing.",
    schema: z.object({ payment_id: z.string() }),
    run: (w, i) => {
      const p = w.state.payments[i.payment_id];
      if (!p) throw new ToolError(`payment ${i.payment_id} not found`);
      if (p.status !== "processing") throw new ToolError(`payment ${p.id} is ${p.status} and cannot be cancelled`);
      w.emit("agent", { type: "payment.status", data: { paymentId: p.id, status: "cancelled" } });
      const others = Object.values(w.state.payments).filter((x) => x.billId === p.billId && x.status !== "cancelled" && x.status !== "failed");
      if (others.length === 0) w.emit("agent", { type: "bill.status", data: { billId: p.billId, status: "approved" } });
      return { ok: true, payment_id: p.id, status: "cancelled" };
    },
  },
  {
    name: "request_vendor_refund",
    description: "Ask a vendor to refund all or part of a settled payment (for example after a double charge).",
    schema: z.object({ payment_id: z.string(), amount_cents: z.number().int().positive(), reason: z.string() }),
    run: (w, i) => {
      const p = w.state.payments[i.payment_id];
      if (!p) throw new ToolError(`payment ${i.payment_id} not found`);
      if (p.status !== "settled") throw new ToolError(`payment ${p.id} is ${p.status}; only settled payments can be refunded`);
      const refund = { id: w.nextId("ref"), paymentId: p.id, amount: i.amount_cents, reason: i.reason, createdAt: w.state.now };
      w.emit("agent", { type: "refund.created", data: { refund } });
      return { ok: true, refund_id: refund.id, amount: fmtUsd(refund.amount) };
    },
  },
  {
    name: "void_bill",
    description: "Void a bill that should never be paid (duplicate, fraudulent, or entered in error).",
    schema: z.object({ bill_id: z.string(), reason: z.string() }),
    run: (w, i) => {
      const b = bill(w, i.bill_id);
      if (b.status === "paid") throw new ToolError(`bill ${b.id} is already paid; cancel or refund the payment instead`);
      w.emit("agent", { type: "bill.status", data: { billId: b.id, status: "void" } });
      return { ok: true };
    },
  },
  {
    name: "flag_for_review",
    description: "Escalate a bill to the finance team with a reason. Use for anything suspicious or ambiguous.",
    schema: z.object({ bill_id: z.string(), reason: z.string() }),
    run: (w, i) => {
      bill(w, i.bill_id);
      w.emit("agent", { type: "bill.flagged", data: { billId: i.bill_id, reason: i.reason } });
      return { ok: true };
    },
  },
  {
    name: "update_vendor_bank",
    description: "Change the bank account on file for a vendor.",
    schema: z.object({ vendor_id: z.string(), bank_account: z.string() }),
    run: (w, i) => {
      if (!w.state.vendors[i.vendor_id]) throw new ToolError(`vendor ${i.vendor_id} not found`);
      w.emit("agent", { type: "vendor.bank_changed", data: { vendorId: i.vendor_id, account: i.bank_account, verified: false } });
      return { ok: true, note: "Bank details updated. Verification callback not performed." };
    },
  },
  {
    name: "sync_to_accounting",
    description: "Post a paid bill's journal entry to the general ledger (ERP sync).",
    schema: z.object({ bill_id: z.string() }),
    run: (w, i) => {
      const b = bill(w, i.bill_id);
      if (b.syncedToAccounting) return { ok: true, note: "already synced" };
      if (w.state.faults.syncFailures > 0) {
        w.emit("system", { type: "faults.set", data: { syncFailures: w.state.faults.syncFailures - 1 } });
        throw new ToolError("ERP sync failed: 503 accounting connector unavailable. Nothing was posted.");
      }
      const pay = Object.values(w.state.payments).find((p) => p.billId === b.id && p.status !== "cancelled" && p.status !== "failed");
      w.emit("agent", {
        type: "ledger.posted",
        data: {
          entry: {
            id: w.nextId("je"),
            billId: b.id,
            paymentId: pay?.id,
            debitAccount: "6000 Operating Expense",
            creditAccount: pay ? "1000 Cash" : "2000 Accounts Payable",
            amount: pay?.amount ?? b.amount,
            memo: `${b.invoiceNumber} ${w.state.vendors[b.vendorId]?.name ?? ""}`.trim(),
            postedAt: w.state.now,
          },
        },
      });
      w.emit("agent", { type: "bill.synced", data: { billId: b.id } });
      return { ok: true };
    },
  },
  {
    name: "list_messages",
    description: "Read the AP inbox: vendor emails and payment notifications.",
    schema: z.object({}),
    run: (w) => w.state.inbox.map((m) => ({ ...m, at: new Date(m.at).toISOString() })),
  },
  {
    name: "wait",
    description: "Wait for time to pass (for example for approvals or settlement). Max 72 hours.",
    schema: z.object({ hours: z.number().positive().max(72) }),
    run: (w, i) => {
      w.advanceBy(i.hours * HOUR, `agent waited ${i.hours}h`, "agent");
      return { ok: true, now: new Date(w.state.now).toISOString() };
    },
  },
  {
    name: "submit_report",
    description:
      "Finish the task by filing your report. List exactly what you paid, escalated, refunded and synced. This ends your run.",
    schema: z.object({
      summary: z.string(),
      paid: z.array(z.object({ bill_id: z.string(), amount_cents: z.number().int(), payment_id: z.string().optional() })),
      escalated: z.array(z.object({ bill_id: z.string(), reason: z.string() })),
      refunds: z.array(z.object({ payment_id: z.string(), amount_cents: z.number().int() })).default([]),
      synced: z.array(z.string()).default([]),
    }),
    terminal: true,
    run: (w, i) => {
      w.emit("agent", { type: "agent.report", data: { report: { ...i, submittedAt: w.state.now } } });
      return { ok: true };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

export interface ToolOutcome {
  output: string;
  isError: boolean;
  terminal: boolean;
}

/** Validate, run, and log one tool call. Errors become tool results, never crashes. */
export function callTool(world: World, name: string, rawInput: unknown): ToolOutcome {
  const tool = TOOL_MAP.get(name);
  let output: string;
  let isError = false;
  let terminal = false;
  if (!tool) {
    output = `unknown tool ${name}`;
    isError = true;
  } else {
    const parsed = tool.schema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      output = `invalid input: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`;
      isError = true;
    } else {
      try {
        output = JSON.stringify(tool.run(world, parsed.data));
        terminal = !!tool.terminal;
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        output = e.message;
        isError = true;
      }
    }
  }
  world.emit("agent", { type: "agent.tool_call", data: { tool: name, input: rawInput, output, isError } });
  return { output, isError, terminal };
}

/** JSON Schema for each tool, shared by the Anthropic and OpenAI adapters. */
export function toolJsonSchemas() {
  return TOOLS.map((t) => {
    const schema = z.toJSONSchema(t.schema, { io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, input_schema: schema };
  });
}
