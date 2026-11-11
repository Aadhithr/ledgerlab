import { useState } from "react";
import { api, usd, type Explanation, type RunRecord } from "../api";
import { go, selectAgent, useStore } from "../store";
import { Pill } from "../ui";

export function GradePanel({ run, onJump }: { run: RunRecord; onJump: (seq: number) => void }) {
  const [expl, setExpl] = useState<Explanation | undefined>(run.explanation);
  const [busy, setBusy] = useState("");
  const keys = useStore((s) => s.meta?.keys);
  const agentNow = useStore((s) => s.agents.find((a) => a.id === run.agent.id));
  const g = run.grade;
  if (!g) {
    return (
      <div className="card card-pad">
        <div className="section-title">Grade</div>
        <div className="muted">The grade appears when the agent files its report or the run ends. Checks read the records, not the agent's words.</div>
      </div>
    );
  }
  const lies = g.reconciliation.filter((r) => !r.match);
  const failed = g.checks.filter((c) => !c.passed);
  const report = run.events.find((e) => e.type === "agent.report")?.data as { report?: { summary: string } } | undefined;

  const askAI = async () => {
    setBusy("explain");
    try {
      setExpl(await api.explain(run.id));
    } finally {
      setBusy("");
    }
  };

  const applyFix = async () => {
    if (!expl?.suggestedInstruction || !agentNow) return;
    setBusy("fix");
    try {
      const a = await api.saveAgent({ ...agentNow, description: `${agentNow.description.trim()}\n\n${expl.suggestedInstruction.trim()}` });
      selectAgent(a.id);
      if (run.testId) {
        const res = await api.startRuns({ agentId: a.id, testIds: [run.testId], paceMs: a.provider === "scripted" ? 500 : undefined });
        go(`run/${res.runIds[0]}`);
      }
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className={`verdict ${g.passed ? "pass" : "fail"}`}>
        <div className="big">{g.passed ? "Passed" : "Failed"}</div>
        <div className="grow small">
          {g.checks.length - failed.length}/{g.checks.length} checks passed
          {!g.passed && <div style={{ fontWeight: 600 }}>{usd(g.dollarsAtRisk)} at risk</div>}
        </div>
      </div>

      {lies.length > 0 && (
        <div className="lie-banner">
          <div className="small" style={{ opacity: 0.7, marginBottom: 6 }}>The agent's report contradicts the records</div>
          {lies.slice(0, 2).map((r) => (
            <div key={r.item} style={{ marginBottom: 6, cursor: r.seqs.length ? "pointer" : undefined }} onClick={() => r.seqs[0] !== undefined && onJump(r.seqs[r.seqs.length - 1])}>
              <div style={{ fontWeight: 600 }}>{r.item}</div>
              <div className="small">Agent said: <span className="claim">{r.claimed}</span></div>
              <div className="small">Records show: <strong>{r.actual}</strong></div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <div className="section-title" style={{ padding: "12px 12px 0" }}>Report vs records</div>
        {report?.report && <div className="small" style={{ padding: "4px 12px 8px" }}><span className="muted">Agent's summary:</span> <em>“{report.report.summary}”</em></div>}
        <table className="t recon">
          <thead><tr><th>Item</th><th>Agent said</th><th>Records show</th></tr></thead>
          <tbody>
            {g.reconciliation.map((r) => (
              <tr key={r.item} className={`${r.match ? "" : "bad"} ${r.seqs.length ? "click" : ""}`} onClick={() => r.seqs.length && onJump(r.seqs[r.seqs.length - 1])}>
                <td>{r.match ? "✓ " : "✕ "}{r.item}</td><td>{r.claimed}</td><td>{r.actual}</td>
              </tr>
            ))}
            {g.reconciliation.length === 0 && <tr><td colSpan={3} className="muted">Nothing claimed, nothing done.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="section-title" style={{ padding: "12px 12px 4px" }}>Checks</div>
        {[...failed, ...g.checks.filter((c) => c.passed)].map((c) => (
          <div className="check-row" key={c.id}>
            <div className="spread">
              <span style={{ fontWeight: 500 }}>{c.passed ? "✓" : "✕"} {c.name}</span>
              {c.passed ? <Pill tone="ok">Pass</Pill> : <Pill tone="bad">{c.severity}</Pill>}
            </div>
            {!c.passed && c.findings.map((f, i) => (
              <div key={i} className="finding" onClick={() => f.seqs.length && onJump(f.seqs[0])} title={f.seqs.length ? "Jump to evidence" : undefined}>
                {f.message}
                {f.seqs.length > 0 && <span className="muted mono" style={{ marginLeft: 6 }}>{f.seqs.map((s) => `#${s}`).join(" ")}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>

      {!g.passed && (
        <div className="card card-pad">
          <div className="spread">
            <div className="section-title" style={{ margin: 0 }}>Why it failed</div>
            {expl?.source !== "ai" && (
              <button className="btn sm" onClick={askAI} disabled={!!busy || !(keys?.anthropic || keys?.openai)} title={keys?.anthropic || keys?.openai ? "" : "Needs an API key"}>
                {busy === "explain" ? <><span className="spin" /> Thinking</> : "Explain with AI"}
              </button>
            )}
          </div>
          {expl && (
            <>
              <div style={{ fontWeight: 600, marginTop: 8 }}>{expl.headline}</div>
              <div className="small" style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{expl.explanation}</div>
              {expl.rootCause && <div className="small" style={{ marginTop: 8 }}><span className="muted">Root cause:</span> {expl.rootCause}</div>}
              {expl.suggestedInstruction && (
                <div style={{ marginTop: 10 }}>
                  <div className="muted small">Suggested addition to the agent's instructions</div>
                  <div className="notice" style={{ marginTop: 4 }}>{expl.suggestedInstruction}</div>
                  {run.agent.provider !== "scripted" && (
                    <button className="btn accent sm" style={{ marginTop: 8 }} disabled={!!busy} onClick={applyFix}>
                      {busy === "fix" ? "Saving" : `Apply as v${(agentNow?.version ?? run.agent.version) + 1} and rerun`}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
