import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyEvent, emptyState } from "../../../src/engine/world";
import { api, simTime, type RunRecord, type WorldEvent, type WorldState } from "../api";
import { go, useRunEvents, useStore } from "../store";
import { Timeline } from "../components/Timeline";
import { WorldStateView } from "../components/WorldState";
import { GradePanel } from "../components/GradePanel";
import { Empty, Pill, ProviderPill, StatusPill, fmtCost } from "../ui";

function stateAt(events: WorldEvent[], seq: number): WorldState {
  const s = emptyState();
  for (const e of events) {
    if (e.seq > seq) break;
    applyEvent(s, e);
  }
  return s;
}

/** Ids of objects an event touched, for highlighting rows in the world view. */
function touchedBy(ev: WorldEvent | undefined): Set<string> {
  const out = new Set<string>();
  if (!ev) return out;
  const d = ev.data as any;
  for (const k of ["billId", "paymentId", "vendorId"]) if (d?.[k]) out.add(d[k]);
  if (d?.bill?.id) out.add(d.bill.id);
  if (d?.payment?.id) { out.add(d.payment.id); out.add(d.payment.billId); }
  if (d?.entry?.id) out.add(d.entry.id);
  if (d?.message?.id) out.add(d.message.id);
  if (d?.refund?.paymentId) out.add(d.refund.paymentId);
  if (ev.type === "agent.tool_call" && d.input?.bill_id) out.add(d.input.bill_id);
  return out;
}

export function RunPage({ runId }: { runId?: string }) {
  const summary = useStore((s) => s.runs.find((r) => r.id === runId));
  const runs = useStore((s) => s.runs);
  const catalog = useStore((s) => s.catalog);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [events, setEvents] = useState<WorldEvent[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [chaos, setChaos] = useState("duplicate_invoice");
  const [playing, setPlaying] = useState(false);
  const seen = useRef(new Set<number>());

  const load = useCallback(async () => {
    if (!runId) return;
    const r = await api.run(runId);
    setRun(r);
    setEvents((prev) => {
      const merged = new Map<number, WorldEvent>();
      for (const e of [...prev, ...r.events]) merged.set(e.seq, e);
      return [...merged.values()].sort((a, b) => a.seq - b.seq);
    });
  }, [runId]);

  useEffect(() => {
    setRun(null);
    setEvents([]);
    setCursor(null);
    seen.current = new Set();
    void load();
  }, [runId, load]);

  useEffect(() => {
    if (summary && (summary.status === "done" || summary.status === "error" || summary.status === "stopped")) void load();
  }, [summary?.status, summary?.passed, load]);

  useRunEvents(runId, useCallback((ev: WorldEvent) => {
    setEvents((prev) => (prev.length && prev[prev.length - 1].seq >= ev.seq ? prev : [...prev, ev]));
  }, []));

  const last = events.length ? events[events.length - 1].seq : 0;
  const at = cursor ?? last;
  const state = useMemo(() => stateAt(events, at), [events, at]);
  const touched = useMemo(() => touchedBy(events.find((e) => e.seq === at)), [events, at]);
  const highlight = useMemo(() => new Set((run?.grade?.checks ?? []).flatMap((c) => c.findings.flatMap((f) => f.seqs))), [run?.grade]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setCursor((c) => {
        const next = events.find((e) => e.seq > (c ?? 0) && !["schedule.added", "faults.set", "seed"].includes(e.type));
        if (!next) { setPlaying(false); return null; }
        return next.seq;
      });
    }, 260);
    return () => clearInterval(t);
  }, [playing, events]);

  if (!runId) {
    return (
      <>
        <h1 className="page-title">Live run</h1>
        <p className="page-sub">Pick a run, or start one from the test plan with “Watch live”.</p>
        <div className="card">
          {runs.slice(0, 20).map((r) => (
            <div key={r.id} className="spread" style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", cursor: "pointer" }} onClick={() => go(`run/${r.id}`)}>
              <span>{r.testTitle} <span className="muted small">· {r.agentName} v{r.version}</span></span>
              <StatusPill run={r} />
            </div>
          ))}
          {!runs.length && <Empty>No runs yet.</Empty>}
        </div>
      </>
    );
  }
  if (!run || !catalog) return <Empty>Loading run…</Empty>;

  const live = summary?.status === "running" || summary?.status === "paused";
  const control = (a: Record<string, unknown>) => api.control(run.id, a).catch((e) => alert(e.message));
  const rerun = async (n: number) => {
    const res = run.testId
      ? await api.startRuns({ agentId: run.agent.id, testIds: [run.testId], repeat: n, paceMs: n === 1 && run.agent.provider === "scripted" ? 600 : undefined })
      : await api.startRuns({ agentId: run.agent.id, scenarioId: run.scenarioId, repeat: n });
    go(n === 1 ? `run/${res.runIds[0]}` : "results");
  };
  const sc = catalog.scenarios.find((s) => s.id === run.scenarioId);

  return (
    <>
      <div className="spread" style={{ marginBottom: 12, alignItems: "flex-start" }}>
        <div>
          <div className="row wrap">
            <h1 className="page-title">{run.testTitle}</h1>
            {summary && <StatusPill run={summary} />}
          </div>
          <div className="row wrap small muted" style={{ marginTop: 4 }}>
            <span>{run.agent.name} v{run.agent.version}</span>
            <ProviderPill provider={run.agent.provider} model={run.agent.model} />
            {run.outcome?.usage && (
              <Pill title={`${run.outcome.usage.inputTokens.toLocaleString()} input + ${run.outcome.usage.outputTokens.toLocaleString()} output tokens`}>
                {fmtCost(run.outcome.usage.costUsd)} · {Math.round((run.outcome.usage.inputTokens + run.outcome.usage.outputTokens) / 100) / 10}k tokens
              </Pill>
            )}
            {sc && <span>· {sc.summary}</span>}
          </div>
        </div>
        {!live && run.agent.provider === "external" && <span className="muted small">Reconnect your agent over MCP to run again.</span>}
        {!live && run.agent.provider !== "external" && (
          <div className="row">
            <button className="btn" onClick={() => rerun(1)}>Run again</button>
            <button className="btn" onClick={() => rerun(10)}>Run ×10</button>
          </div>
        )}
      </div>

      <div className="card card-pad" style={{ marginBottom: 14, padding: "12px 14px" }}>
        <div className="row wrap" style={{ gap: 14 }}>
          <div>
            <div className="muted small">{cursor === null ? "Sim clock" : `Viewing #${at}`}</div>
            <div className="clock">{simTime(state.now)}</div>
          </div>
          {live ? (
            <>
              <div className="row">
                {summary?.status === "paused" ? (
                  <>
                    <button className="btn primary sm" onClick={() => control({ type: "resume" })}>Resume</button>
                    <button className="btn sm" onClick={() => control({ type: "step" })}>Step</button>
                  </>
                ) : (
                  <button className="btn sm" onClick={() => control({ type: "pause" })}>Pause</button>
                )}
                <button className="btn sm danger" onClick={() => control({ type: "stop" })}>Stop</button>
              </div>
              <div className="row">
                <span className="muted small">Move clock</span>
                {[1, 24, 72, 168].map((h) => (
                  <button key={h} className="btn sm" onClick={() => control({ type: "advance_clock", hours: h })}>+{h < 24 ? `${h}h` : `${h / 24}d`}</button>
                ))}
              </div>
              <div className="row grow" style={{ minWidth: 280 }}>
                <select className="select" value={chaos} onChange={(e) => setChaos(e.target.value)} style={{ height: 30, padding: "2px 8px" }}>
                  {catalog.chaos.map((c) => <option key={c.kind} value={c.kind}>{c.label}</option>)}
                </select>
                <button className="btn sm" style={{ background: "var(--chaos-bg)", color: "var(--chaos)", borderColor: "transparent" }} onClick={() => control({ type: "chaos", kind: chaos })}>Inject</button>
              </div>
            </>
          ) : (
            <div className="row grow">
              <button className="btn sm" onClick={() => { setCursor(0); setPlaying(true); }}>{playing ? "Replaying…" : "Replay"}</button>
              {playing && <button className="btn sm" onClick={() => setPlaying(false)}>Pause</button>}
              <input className="scrub grow" type="range" min={0} max={last} value={at} onChange={(e) => { setPlaying(false); setCursor(Number(e.target.value)); }} />
              {cursor !== null && <button className="btn sm ghost" onClick={() => setCursor(null)}>End</button>}
            </div>
          )}
        </div>
        {live && (
          <input className="scrub" type="range" min={0} max={last} value={at} onChange={(e) => setCursor(Number(e.target.value) >= last ? null : Number(e.target.value))} style={{ marginTop: 10 }} />
        )}
      </div>

      <div className="run-grid">
        <Timeline events={events} cursor={at} onSelect={(s) => { setPlaying(false); setCursor(s === last ? null : s); }} follow={cursor === null} highlight={highlight} />
        <WorldStateView state={state} touched={touched} />
        <GradePanel key={run.grade ? `g-${run.id}` : `p-${run.id}`} run={run} onJump={(s) => { setPlaying(false); setCursor(s); }} />
      </div>
      {run.outcome?.error && <div className="notice warn" style={{ marginTop: 12 }}>Run ended with an error: {run.outcome.error}</div>}
    </>
  );
}
