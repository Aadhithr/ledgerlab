import { describe, expect, it } from "vitest";
import { World, stateAt } from "../src/engine/world.js";
import { callTool } from "../src/engine/tools.js";
import { injectChaos } from "../src/engine/chaos.js";
import { baseSeed } from "../src/scenarios/library.js";
import { HOUR } from "../src/engine/types.js";

describe("world engine", () => {
  it("replaying the log reproduces the live state", () => {
    const w = new World(baseSeed());
    callTool(w, "pay_bill", { bill_id: "bill_001" });
    injectChaos(w, "duplicate_invoice", { billId: "bill_001" });
    w.advanceBy(30 * HOUR, "test");
    const replayed = stateAt(w.events, w.events.length);
    expect(replayed).toEqual(JSON.parse(JSON.stringify(w.state)));
  });

  it("settles payments when the clock passes their settlement time", () => {
    const w = new World(baseSeed());
    callTool(w, "pay_bill", { bill_id: "bill_003" });
    expect(w.state.payments.pay_001.status).toBe("processing");
    w.advanceBy(25 * HOUR, "test");
    expect(w.state.payments.pay_001.status).toBe("settled");
    expect(w.state.inbox.some((m) => m.subject.includes("pay_001"))).toBe(true);
  });

  it("delayed notifications arrive later than settlement", () => {
    const w = new World(baseSeed());
    injectChaos(w, "delay_notification");
    callTool(w, "pay_bill", { bill_id: "bill_003" });
    w.advanceBy(30 * HOUR, "test");
    expect(w.state.payments.pay_001.status).toBe("settled");
    expect(w.state.inbox.length).toBe(0);
    w.advanceBy(48 * HOUR, "test");
    expect(w.state.inbox.length).toBe(1);
  });

  it("a timed-out payment still exists", () => {
    const w = new World(baseSeed());
    injectChaos(w, "payment_timeout");
    const out = callTool(w, "pay_bill", { bill_id: "bill_001" });
    expect(out.isError).toBe(true);
    expect(out.output).toMatch(/504/);
    expect(Object.keys(w.state.payments)).toEqual(["pay_001"]);
  });

  it("idempotency keys prevent a second payment", () => {
    const w = new World(baseSeed());
    callTool(w, "pay_bill", { bill_id: "bill_001", idempotency_key: "k1" });
    callTool(w, "pay_bill", { bill_id: "bill_001", idempotency_key: "k1" });
    expect(Object.keys(w.state.payments)).toHaveLength(1);
  });

  it("invalid tool input becomes an error result, not a crash", () => {
    const w = new World(baseSeed());
    const out = callTool(w, "pay_bill", { bill_id: 42 });
    expect(out.isError).toBe(true);
    expect(callTool(w, "nope", {}).isError).toBe(true);
  });

  it("request_approval leads to a human approval after the clock moves", () => {
    const w = new World(baseSeed());
    callTool(w, "request_approval", { bill_id: "bill_004" });
    expect(w.state.bills.bill_004.status).toBe("pending_approval");
    w.advanceBy(21 * HOUR, "test");
    expect(w.state.bills.bill_004.status).toBe("approved");
    expect(w.state.bills.bill_004.approvals[0].role).toBe("human");
  });
});
