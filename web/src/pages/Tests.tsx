import { useEffect, useMemo, useRef, useState } from "react";
import { api, type TestDef } from "../api";
import { go, useStore } from "../store";
import { Empty, Pill, Rate } from "../ui";

export function TestsPage({ autoGenerate }: { autoGenerate?: boolean }) {
  const agentId = useStore((s) => s.selectedAgentId);
  const agent = useStore((s) => s.agents.find((a) => a.id === s.selectedAgentId));
  const allTests = useStore((s) => s.tests);
  const runs = useStore((s) => s.runs);
  const catalog = useStore((s) => s.catalog);
  const tests = useMemo(() => allTests.filter((t) => t.agentId === agentId), [allTests, agentId]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [request, setRequest] = useState("");
  const [rules, setRules] = useState("");
  const [repeat, setRepeat] = useState(5);
  const [manual, setManual] = useState({ scenarioId: "happy_path", chaos: [] as string[], task: "" });
  const autoRan = useRef(false);

  const generate = async (opts: { request?: string; rules?: string[]; replace?: boolean }) => {
    if (!agentId) return;
    setBusy("generate");
    setNote("");
    try {
      const plan = await api.plan({ agentId, ...opts });
      setNote(`${plan.tests.length} test${plan.tests.length === 1 ? "" : "s"} written by ${plan.generator === "ai" ? "the lab model" : "keyword matching"}${plan.rules.length ? `, ${plan.rules.length} rule${plan.rules.length === 1 ? "" : "s"} compiled` : ""}.${plan.note ? ` ${plan.note}` : ""}`);
      setSelected(new Set(plan.tests.map((t) => t.id)));
    } catch (e) {
      setNote(`Generation failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    if (autoGenerate && agentId && !autoRan.current) {
      autoRan.current = true;
      void generate({ replace: true });
    }
  }, [autoGenerate, agentId]);

  if (!agent || !catalog) return <Empty>Select or create an agent first.</Empty>;

  const scenarioTitle = (id: string) => catalog.scenarios.find((s) => s.id === id)?.title ?? id;
  const checkName = (id: string) => catalog.checks.find((c) => c.id === id)?.name ?? id;
  const chaosLabel = (k: string) => catalog.chaos.find((c) => c.kind === k)?.label ?? k;
  const groups = new Map<string, TestDef[]>();
  for (const t of tests) groups.set(t.capability, [...(groups.get(t.capability) ?? []), t]);

  const history = (t: TestDef) => {
    const rs = runs.filter((r) => r.testId === t.id && r.agentId === agent.id && r.version === agent.version && r.status === "done");
    return { pass: rs.filter((r) => r.passed).length, total: rs.length };
  };

  const run = async (ids: string[], n: number, live = false) => {
    setBusy("run");
    try {
      // Watch live starts paused before the first move and paces every step, so there is time to inject chaos or move the clock.
      const res = await api.startRuns(live
        ? { agentId: agent.id, testIds: ids, repeat: 1, paceMs: agent.provider === "scripted" ? 900 : 1200, startPaused: true }
        : { agentId: agent.id, testIds: ids, repeat: n });
      if (res.runIds.length === 1 || live) go(`run/${res.runIds[0]}`);
      else go("results");
    } catch (e) {
      setNote(`Could not start: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy("");
    }
  };

  const toggle = (id: string) => {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  };
  const sel = tests.filter((t) => selected.has(t.id)).map((t) => t.id);

  return (
    <>
      <div className="spread">
        <div>
          <h1 className="page-title">Test plan · {agent.name} <span className="muted" style={{ fontWeight: 400 }}>v{agent.version}</span></h1>
          <p className="page-sub">Tests are grouped by what the agent is responsible for. Each one runs the agent in a fresh copy of the Bill Pay world and grades the resulting records, not the agent's account of them.</p>
        </div>
        <button className="btn accent" disabled={!!busy} onClick={() => generate({ replace: true })}>
          {busy === "generate" ? <><span className="spin" /> Writing tests</> : tests.length ? "Regenerate from description" : "Generate test plan"}
        </button>
      </div>
      {note && <div className="notice" style={{ marginBottom: 14 }}>{note}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 16, alignItems: "start" }}>
        <div className="col" style={{ gap: 14 }}>
          <div className="card card-pad spread" style={{ padding: "10px 14px", position: "sticky", top: -22, zIndex: 2 }}>
            <div className="row">
              <input type="checkbox" checked={sel.length > 0 && sel.length === tests.length} onChange={(e) => setSelected(new Set(e.target.checked ? tests.map((t) => t.id) : []))} />
              <span className="small muted">{sel.length} of {tests.length} selected</span>
            </div>
            <div className="row">
              <span className="small muted">Repeat</span>
              <input className="input" type="number" min={1} max={25} value={repeat} onChange={(e) => setRepeat(Math.max(1, Math.min(25, Number(e.target.value))))} style={{ width: 64, height: 32 }} />
              <button className="btn" disabled={!sel.length || !!busy} onClick={() => run(sel, 1)}>Run once</button>
              <button className="btn primary" disabled={!sel.length || !!busy} onClick={() => run(sel, repeat)}>Run ×{repeat}</button>
            </div>
          </div>

          {tests.length === 0 && <div className="card"><Empty>No tests yet. Generate a plan from the agent's description, or add one on the right.</Empty></div>}

          {[...groups].map(([cap, ts]) => (
            <div className="card" key={cap}>
              <div className="spread" style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
                <h3 style={{ margin: 0 }}>{cap}</h3>
                <span className="muted small">{ts.length} test{ts.length > 1 ? "s" : ""}</span>
              </div>
              {ts.map((t) => {
                const h = history(t);
                return (
                  <div className="test-card" key={t.id}>
                    <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} style={{ marginTop: 3 }} />
                    <div>
                      <div className="row wrap">
                        <strong style={{ fontWeight: 600 }}>{t.title}</strong>
                        {t.source === "custom" && <Pill tone="accent">Custom</Pill>}
                        {t.title !== scenarioTitle(t.scenarioId) && <span className="muted small">on “{scenarioTitle(t.scenarioId)}”</span>}
                      </div>
                      <div className="muted small" style={{ marginTop: 2 }}>{t.rationale}</div>
                      {t.task && <div className="small" style={{ marginTop: 4 }}><span className="muted">Task:</span> {t.task}</div>}
                      <div className="chips">
                        {[...catalog.scenarios.find((s) => s.id === t.scenarioId)!.timeline.map((x) => x.chaos), ...t.extraChaos.map((x) => x.chaos)].map((k, i) => (
                          <Pill key={k + i} tone="chaos">{chaosLabel(k)}</Pill>
                        ))}
                      </div>
                      <div className="chips">
                        {t.checks.map((c) => <Pill key={c}>{checkName(c)}</Pill>)}
                        {t.rules.map((r) => <Pill key={r.id} tone="info" title={JSON.stringify(r.spec)}>Rule: {r.text}</Pill>)}
                      </div>
                    </div>
                    <div className="col" style={{ alignItems: "flex-end", gap: 6 }}>
                      <Rate pass={h.pass} total={h.total} />
                      <div className="row">
                        <button className="btn sm primary" disabled={!!busy} onClick={() => run([t.id], 1, true)} title="Opens the run paused so you can step through it, inject exceptions and move the clock">▶ Watch live</button>
                        <button className="btn sm ghost" onClick={() => api.deleteTest(t.id)} title="Delete test">✕</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="col" style={{ gap: 14, position: "sticky", top: 0 }}>
          <div className="card card-pad">
            <h3>Test something specific</h3>
            <p className="muted small" style={{ marginTop: 0 }}>Describe a job in plain English. The lab writes focused tests for it.</p>
            <textarea className="textarea" placeholder="Refund a double-charge ticket from Kestrel" value={request} onChange={(e) => setRequest(e.target.value)} />
            <div className="field" style={{ marginTop: 10 }}>
              <label className="label">Rules it must follow (one per line)</label>
              <textarea className="textarea" placeholder={"Never bypasses approval\nOnly refunds once\nEscalates anything over $15,000"} value={rules} onChange={(e) => setRules(e.target.value)} />
            </div>
            <button
              className="btn primary"
              disabled={!!busy || (!request.trim() && !rules.trim())}
              onClick={() => generate({ request: request.trim() || undefined, rules: rules.split("\n").map((r) => r.trim()).filter(Boolean) })}
            >
              {busy === "generate" ? <><span className="spin" /> Writing</> : "Write tests"}
            </button>
          </div>

          <div className="card card-pad">
            <h3>Add a test by hand</h3>
            <div className="field" style={{ marginTop: 8 }}>
              <label className="label">Scenario</label>
              <select className="select" value={manual.scenarioId} onChange={(e) => setManual({ ...manual, scenarioId: e.target.value })}>
                {catalog.scenarios.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label">Extra exceptions at start</label>
              <div className="chips">
                {catalog.chaos.map((c) => (
                  <button key={c.kind} className={`pill ${manual.chaos.includes(c.kind) ? "chaos" : ""}`} style={{ border: 0, cursor: "pointer" }} title={c.description}
                    onClick={() => setManual({ ...manual, chaos: manual.chaos.includes(c.kind) ? manual.chaos.filter((k) => k !== c.kind) : [...manual.chaos, c.kind] })}>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="label">Task override (optional)</label>
              <input className="input" value={manual.task} onChange={(e) => setManual({ ...manual, task: e.target.value })} placeholder="Leave empty to use the scenario's task" />
            </div>
            <button className="btn" onClick={() => api.addTest({ agentId: agent.id, scenarioId: manual.scenarioId, extraChaos: manual.chaos, task: manual.task || undefined })}>Add test</button>
          </div>
        </div>
      </div>
    </>
  );
}
