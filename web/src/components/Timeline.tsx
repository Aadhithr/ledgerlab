import { useEffect, useRef, useState } from "react";
import { simTime, usd, type WorldEvent } from "../api";

const HIDDEN = new Set(["seed", "schedule.added", "faults.set", "bill.synced", "bill.status"]);

type Filter = "all" | "agent" | "money" | "chaos";
const MONEY = new Set(["payment.created", "payment.status", "refund.created", "ledger.posted", "vendor.bank_changed", "agent.report"]);

function short(v: unknown, n = 140) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function describe(ev: WorldEvent): { who: string; body: React.ReactNode; err?: boolean; strong?: boolean } {
  const d = ev.data as any;
  switch (ev.type) {
    case "agent.tool_call": {
      const args = d.input && Object.keys(d.input).length ? short(d.input, 90) : "";
      return {
        who: "Agent → tool",
        err: d.isError,
        body: (
          <>
            <span className="mono" style={{ fontWeight: 500, color: "var(--ink)" }}>{d.tool}</span>
            <span className="mono muted">({args})</span>
            <div className="mono" style={{ fontSize: 11, marginTop: 2 }}>{d.isError ? "✕ " : "→ "}{short(d.output, 160)}</div>
          </>
        ),
      };
    }
    case "agent.message":
      return { who: "Agent says", body: <span className="say">“{short(d.text, 400)}”</span> };
    case "agent.report":
      return { who: "Agent report", strong: true, body: <>Filed report: paid {d.report.paid.length}, escalated {d.report.escalated.length}, synced {d.report.synced.length}. <span className="say">“{short(d.report.summary, 200)}”</span></> };
    case "chaos.injected":
      return { who: ev.actor === "user" ? "You injected" : "Scenario injected", body: <strong style={{ fontWeight: 600 }}>{d.label}</strong> };
    case "clock.advanced":
      return { who: "Clock", body: <>→ {simTime(d.to)} <span className="muted">({d.reason})</span></> };
    case "payment.created":
      return { who: "Money moved", strong: true, body: <><span className="mono">{d.payment.id}</span> {usd(d.payment.amount)} to {d.payment.toAccount} for <span className="mono">{d.payment.billId}</span></> };
    case "payment.status":
      return { who: "Payment", body: <><span className="mono">{d.paymentId}</span> is now {d.status}</> };
    case "refund.created":
      return { who: "Refund", strong: true, body: <>Requested {usd(d.refund.amount)} back on <span className="mono">{d.refund.paymentId}</span></> };
    case "ledger.posted":
      return { who: "Ledger", body: <>Posted {usd(d.entry.amount)} · {d.entry.memo}</> };
    case "inbox.received":
      return { who: "Inbox", body: <>{d.message.subject}</> };
    case "bill.created":
      return { who: ev.actor === "system" ? "Bill" : "New bill", body: <><span className="mono">{d.bill.id}</span> {d.bill.invoiceNumber} {usd(d.bill.amount)} ({d.bill.status.replace("_", " ")})</> };
    case "bill.approved":
      return { who: "Approval", body: <><span className="mono">{d.billId}</span> approved by {d.approval.by} ({d.approval.role})</> };
    case "bill.flagged":
      return { who: "Escalated", body: <><span className="mono">{d.billId}</span>: {d.reason}</> };
    case "bill.attachment_removed":
      return { who: "Evidence", body: <>Attachment removed from <span className="mono">{d.billId}</span></> };
    case "vendor.bank_changed":
      return { who: "Vendor", strong: true, err: true, body: <>Bank account for {d.vendorId} changed to {d.account} (unverified)</> };
    case "run.note":
      return { who: "Lab", body: <span className="muted">{d.text}</span> };
    default:
      return { who: ev.type, body: short(d) };
  }
}

export function Timeline({ events, cursor, onSelect, follow, highlight }: { events: WorldEvent[]; cursor: number; onSelect: (seq: number) => void; follow: boolean; highlight: Set<number> }) {
  const [filter, setFilter] = useState<Filter>("all");
  const box = useRef<HTMLDivElement>(null);
  const shown = events.filter((e) => {
    if (HIDDEN.has(e.type)) return false;
    if (filter === "agent") return e.actor === "agent" && (e.type === "agent.tool_call" || e.type === "agent.message" || e.type === "agent.report");
    if (filter === "money") return MONEY.has(e.type);
    if (filter === "chaos") return e.type === "chaos.injected" || e.actor === "chaos" || e.actor === "user";
    return true;
  });

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [events.length, follow]);

  useEffect(() => {
    if (follow || !box.current) return;
    const el = box.current.querySelector<HTMLElement>(`[data-seq="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor, follow]);

  return (
    <div className="card">
      <div className="tabs">
        {(["all", "agent", "money", "chaos"] as Filter[]).map((f) => (
          <button key={f} className={`tab ${filter === f ? "active" : ""}`} onClick={() => setFilter(f)}>
            {f === "all" ? "Everything" : f === "agent" ? "Agent" : f === "money" ? "Money" : "Chaos"}
          </button>
        ))}
      </div>
      <div className="timeline" ref={box}>
        {shown.map((e) => {
          const d = describe(e);
          const cls = [
            "ev",
            e.actor,
            d.err ? "err" : "",
            e.seq === cursor ? "sel" : "",
            e.seq > cursor ? "future" : "",
          ].join(" ");
          return (
            <div key={e.seq} data-seq={e.seq} className={cls} onClick={() => onSelect(e.seq)} style={highlight.has(e.seq) ? { boxShadow: "inset 3px 0 0 var(--bad)" } : undefined}>
              <div className="seq">#{e.seq}</div>
              <div>
                <div className="spread">
                  <span className="who">{d.who}</span>
                  <span className="muted mono" style={{ fontSize: 10.5 }}>{simTime(e.at)}</span>
                </div>
                <div className="body" style={d.strong ? { color: "var(--ink)" } : undefined}>{d.body}</div>
              </div>
            </div>
          );
        })}
        {shown.length === 0 && <div className="empty">Nothing yet.</div>}
      </div>
    </div>
  );
}
