import { useEffect, useMemo, useState } from "react";
import { api, usd, type BatchRecord, type RunSummary } from "../api";
import { go, useStore } from "../store";
import { Empty, Pill, Rate, StatusPill, fmtCost } from "../ui";

const keyOf = (r: RunSummary) => `${r.agentId}@${r.version}`;

export function ResultsPage() {
  const runs = useStore((s) => s.runs);
  const catalog = useStore((s) => s.catalog);
  const [batches, setBatches] = useState<BatchRecord[]>([]);
  const [compare, setCompare] = useState<string[]>([]);

  useEffect(() => {
    void api.batches().then(setBatches);
  }, [runs.length]);

  const done = runs.filter((r) => r.status === "done");
  const variants = useMemo(() => {
    const m = new Map<string, { key: string; label: string; n: number }>();
    for (const r of done) {
      const k = keyOf(r);
      const cur = m.get(k) ?? { key: k, label: `${r.agentName} v${r.version}`, n: 0 };
      cur.n++;
      m.set(k, cur);
    }
    return [...m.values()];
  }, [done.length]);

  useEffect(() => {
    if (compare.length === 0 && variants.length) setCompare(variants.slice(0, 3).map((v) => v.key));
  }, [variants.length]);

  if (!catalog) return null;
  const checkName = (id: string) => catalog.checks.find((c) => c.id === id)?.name ?? id;
  const live = runs.filter((r) => r.status === "running" || r.status === "paused");

  const titles = [...new Set(done.filter((r) => compare.includes(keyOf(r))).map((r) => r.testTitle))].sort();

  return (
    <>
      <h1 className="page-title">Results</h1>
      <p className="page-sub">Run the same test many times to see how reliable an agent is, and compare agents or versions on identical scenarios. Every number here comes from the records each run left behind.</p>

      {live.length > 0 && <div className="notice" style={{ marginBottom: 14 }}><span className="spin" /> {live.length} run{live.length > 1 ? "s" : ""} in progress. This page updates as they finish.</div>}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="spread card-pad" style={{ paddingBottom: 8 }}>
          <h3 style={{ margin: 0 }}>Compare agents and versions</h3>
          <div className="chips" style={{ marginTop: 0 }}>
            {variants.map((v) => (
              <button key={v.key} className={`pill ${compare.includes(v.key) ? "accent" : ""}`} style={{ border: 0, cursor: "pointer" }}
                onClick={() => setCompare(compare.includes(v.key) ? compare.filter((k) => k !== v.key) : [...compare, v.key])}>
                {v.label} <span className="muted">({v.n})</span>
              </button>
            ))}
          </div>
        </div>
        {titles.length && compare.length ? (
          <table className="t matrix">
            <thead>
              <tr>
                <th>Test</th>
                {compare.map((k) => <th key={k} className="num" style={{ textAlign: "center" }}>{variants.find((v) => v.key === k)?.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {titles.map((t) => (
                <tr key={t}>
                  <td>{t}</td>
                  {compare.map((k) => {
                    const rs = done.filter((r) => r.testTitle === t && keyOf(r) === k);
                    return <td key={k} className="cell"><Rate pass={rs.filter((r) => r.passed).length} total={rs.length} /></td>;
                  })}
                </tr>
              ))}
              <tr>
                <td style={{ fontWeight: 600 }}>All tests</td>
                {compare.map((k) => {
                  const rs = done.filter((r) => keyOf(r) === k && titles.includes(r.testTitle));
                  const risk = rs.reduce((a, r) => a + (r.dollarsAtRisk ?? 0), 0);
                  return (
                    <td key={k} className="cell">
                      <Rate pass={rs.filter((r) => r.passed).length} total={rs.length} />
                      <div className="muted small">{usd(rs.length ? Math.round(risk / rs.length) : 0)} avg at risk</div>
                      <div className="muted small">{rs.filter((r) => r.caughtLie).length} contradicted reports</div>
                      {rs.some((r) => typeof r.costUsd === "number") && (
                        <div className="muted small">{fmtCost(rs.reduce((a, r) => a + (r.costUsd ?? 0), 0) / rs.length)} avg per run</div>
                      )}
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        ) : <Empty>Run some tests to compare.</Empty>}
      </div>

      {batches.slice(0, 6).map((b) => {
        const rs = b.runIds.map((id) => runs.find((r) => r.id === id)).filter((r): r is RunSummary => !!r);
        const fin = rs.filter((r) => r.status === "done");
        const checkIds = [...new Set(fin.flatMap((r) => Object.keys(r.checkResults)))];
        const byTest = new Map<string, RunSummary[]>();
        for (const r of rs) byTest.set(r.testTitle, [...(byTest.get(r.testTitle) ?? []), r]);
        return (
          <div className="card" key={b.id} style={{ marginBottom: 16 }}>
            <div className="spread card-pad" style={{ paddingBottom: 8 }}>
              <div>
                <h3 style={{ margin: 0 }}>{b.label}</h3>
                <div className="muted small">{new Date(b.createdAt).toLocaleString()} · {fin.length}/{rs.length} finished</div>
              </div>
              <div className="row">
                <Rate pass={fin.filter((r) => r.passed).length} total={fin.length} />
                <Pill tone={fin.some((r) => r.caughtLie) ? "bad" : undefined}>{fin.filter((r) => r.caughtLie).length} contradicted reports</Pill>
              </div>
            </div>
            <div className="grid2" style={{ padding: "0 16px 16px" }}>
              <div>
                <div className="section-title">By test</div>
                <table className="t">
                  <tbody>
                    {[...byTest].map(([t, list]) => {
                      const f = list.filter((r) => r.status === "done");
                      const firstFail = f.find((r) => !r.passed);
                      return (
                        <tr key={t} className={firstFail ? "click" : ""} onClick={() => firstFail && go(`run/${firstFail.id}`)}>
                          <td>{t}{firstFail && <div className="muted small">Open a failing run</div>}</td>
                          <td className="num"><Rate pass={f.filter((r) => r.passed).length} total={f.length} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="section-title">By check (pass rate across runs)</div>
                <table className="t">
                  <tbody>
                    {checkIds.map((c) => {
                      const rel = fin.filter((r) => c in r.checkResults);
                      return (
                        <tr key={c}>
                          <td>{checkName(c)}</td>
                          <td className="num"><Rate pass={rel.filter((r) => r.checkResults[c]).length} total={rel.length} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })}

      <div className="card">
        <div className="card-pad" style={{ paddingBottom: 8 }}><h3 style={{ margin: 0 }}>All runs</h3></div>
        {runs.length ? (
          <table className="t">
            <thead><tr><th>Test</th><th>Agent</th><th>Result</th><th>Failed checks</th><th className="num">At risk</th><th className="num">Cost</th><th>Started</th></tr></thead>
            <tbody>
              {runs.slice(0, 200).map((r) => (
                <tr key={r.id} className="click" onClick={() => go(`run/${r.id}`)}>
                  <td>{r.testTitle}{r.batchId && <span className="muted small"> #{r.index + 1}</span>}</td>
                  <td className="small">{r.agentName} v{r.version}</td>
                  <td><StatusPill run={r} /></td>
                  <td className="small muted">{r.failedChecks.map(checkName).join(", ") || "—"}</td>
                  <td className="num mono">{r.dollarsAtRisk ? usd(r.dollarsAtRisk) : "—"}</td>
                  <td className="num mono small">{r.provider === "scripted" ? "free" : fmtCost(r.costUsd)}</td>
                  <td className="small muted">{new Date(r.startedAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>No runs yet. Start from the test plan.</Empty>}
      </div>
    </>
  );
}
