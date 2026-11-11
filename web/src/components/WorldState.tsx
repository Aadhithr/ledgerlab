import { useState } from "react";
import { simTime, usd, type WorldState as WS } from "../api";
import { Pill } from "../ui";

type Tab = "bills" | "payments" | "ledger" | "inbox" | "vendors";

const billTone = (s: string) => (s === "paid" ? "ok" : s === "approved" ? "info" : s === "void" || s === "rejected" ? "bad" : "warn") as "ok" | "info" | "bad" | "warn";
const payTone = (s: string) => (s === "settled" ? "ok" : s === "processing" ? "info" : "bad") as "ok" | "info" | "bad";

export function WorldStateView({ state, touched }: { state: WS; touched: Set<string> }) {
  const [tab, setTab] = useState<Tab>("bills");
  const bills = Object.values(state.bills);
  const pays = Object.values(state.payments);
  const paidOut = pays.filter((p) => p.status === "processing" || p.status === "settled").reduce((a, p) => a + p.amount, 0);
  const posted = state.ledger.reduce((a, e) => a + e.amount, 0);
  const refunds = Object.values(state.refunds);
  const counts: Record<Tab, number> = { bills: bills.length, payments: pays.length, ledger: state.ledger.length, inbox: state.inbox.length, vendors: Object.keys(state.vendors).length };
  const vendor = (id: string) => state.vendors[id]?.name ?? id;
  const rowCls = (id: string) => (touched.has(id) ? "new" : "");

  return (
    <div className="card">
      <div className="grid3" style={{ gridTemplateColumns: "repeat(4, minmax(0,1fr))", padding: 14, gap: 10, borderBottom: "1px solid var(--line)" }}>
        <Stat label="Sim time" value={simTime(state.now)} mono />
        <Stat label="Paid out" value={usd(paidOut)} />
        <Stat label="Posted to ledger" value={usd(posted)} tone={posted !== paidOut && pays.length ? "warn" : undefined} />
        <Stat label="Refunds requested" value={refunds.length ? `${refunds.length} · ${usd(refunds.reduce((a, r) => a + r.amount, 0))}` : "none"} />
      </div>
      <div className="tabs">
        {(Object.keys(counts) as Tab[]).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)} <span className="muted">{counts[t]}</span>
          </button>
        ))}
      </div>
      <div style={{ overflow: "auto", maxHeight: "calc(100vh - 380px)" }}>
        {tab === "bills" && (
          <table className="t">
            <thead><tr><th>Bill</th><th>Vendor · invoice</th><th className="num">Amount</th><th>Due</th><th>Status</th><th>Approvals</th><th>Evidence</th></tr></thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.id} className={rowCls(b.id)}>
                  <td className="mono">{b.id}</td>
                  <td>{vendor(b.vendorId)}<div className="muted small mono">{b.invoiceNumber}</div>{b.memo && <div className="muted small" style={{ maxWidth: 260 }}>“{b.memo}”</div>}</td>
                  <td className="num mono">{usd(b.amount)}</td>
                  <td className="small">{simTime(b.dueAt).split(",").slice(0, 2).join(",")}</td>
                  <td>
                    <Pill tone={billTone(b.status)}>{b.status.replace("_", " ")}</Pill>
                    {b.flagged && <div style={{ marginTop: 4 }}><Pill tone="warn" title={b.flagged.reason}>Escalated</Pill></div>}
                    {b.syncedToAccounting && <div style={{ marginTop: 4 }}><Pill>Synced</Pill></div>}
                  </td>
                  <td className="small">{b.approvals.length ? b.approvals.map((a) => <div key={a.by + a.at}>{a.by} <span className="muted">({a.role})</span></div>) : <span className="muted">none / {b.requiredApprovals} needed</span>}</td>
                  <td className="small">{b.attachments.length ? b.attachments.map((a) => <div key={a.id} className="mono" title={a.hash}>{a.filename}</div>) : <Pill tone="bad">missing</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === "payments" && (
          pays.length ? (
            <table className="t">
              <thead><tr><th>Payment</th><th>Bill</th><th className="num">Amount</th><th>To account</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>
                {pays.map((p) => {
                  const dup = pays.filter((x) => x.billId === p.billId && (x.status === "processing" || x.status === "settled")).length > 1;
                  return (
                    <tr key={p.id} className={`${rowCls(p.id)} ${dup ? "bad" : ""}`}>
                      <td className="mono">{p.id}</td>
                      <td className="mono">{p.billId}{dup && <div><Pill tone="bad">Duplicate</Pill></div>}</td>
                      <td className="num mono">{usd(p.amount)}</td>
                      <td className="mono">{p.toAccount}{state.vendors[p.vendorId]?.previousBankAccount && p.toAccount === state.vendors[p.vendorId].bankAccount && !state.vendors[p.vendorId].bankVerified && <div><Pill tone="bad">Unverified</Pill></div>}</td>
                      <td><Pill tone={payTone(p.status)}>{p.status}</Pill></td>
                      <td className="small">{simTime(p.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <div className="empty">No payments yet.</div>
        )}
        {tab === "ledger" && (
          state.ledger.length ? (
            <table className="t">
              <thead><tr><th>Entry</th><th>Bill</th><th>Debit</th><th>Credit</th><th className="num">Amount</th><th>Posted</th></tr></thead>
              <tbody>
                {state.ledger.map((e) => (
                  <tr key={e.id} className={rowCls(e.id)}>
                    <td className="mono">{e.id}</td><td className="mono">{e.billId}</td><td className="small">{e.debitAccount}</td><td className="small">{e.creditAccount}</td>
                    <td className="num mono">{usd(e.amount)}</td><td className="small">{simTime(e.postedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="empty">Nothing posted to the general ledger.</div>
        )}
        {tab === "inbox" && (
          state.inbox.length ? state.inbox.map((m) => (
            <div key={m.id} className={rowCls(m.id)} style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)" }}>
              <div className="spread"><strong style={{ fontWeight: 600 }}>{m.subject}</strong><span className="muted small">{simTime(m.at)}</span></div>
              <div className="muted small">{m.from}</div>
              <div className="small" style={{ marginTop: 4 }}>{m.body}</div>
            </div>
          )) : <div className="empty">Inbox empty.</div>
        )}
        {tab === "vendors" && (
          <table className="t">
            <thead><tr><th>Vendor</th><th>Bank account</th><th>Verified</th></tr></thead>
            <tbody>
              {Object.values(state.vendors).map((v) => (
                <tr key={v.id} className={rowCls(v.id)}>
                  <td>{v.name}<div className="mono muted small">{v.id}</div></td>
                  <td className="mono">{v.bankAccount}{v.previousBankAccount && <div className="muted small">was {v.previousBankAccount}</div>}</td>
                  <td>{v.bankVerified ? <Pill tone="ok">Verified</Pill> : <Pill tone="bad">Unverified</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: "warn" }) {
  return (
    <div>
      <div className="muted small">{label}</div>
      <div className={mono ? "mono" : ""} style={{ fontWeight: 600, fontSize: mono ? 13 : 15, color: tone === "warn" ? "var(--warn)" : undefined, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}
