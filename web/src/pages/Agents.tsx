import { useEffect, useState } from "react";
import { api, type AgentConfig } from "../api";
import { go, selectAgent, useStore } from "../store";
import { Pill, ProviderPill } from "../ui";
import { ConnectAgent } from "../components/ConnectAgent";

type Draft = Pick<AgentConfig, "name" | "description" | "provider" | "model" | "maxSteps"> & { id?: string; effort?: AgentConfig["effort"] };

const blank = (defaults?: { anthropic: string }): Draft => ({
  name: "New AP agent",
  description: "",
  provider: "anthropic",
  model: defaults?.anthropic ?? "claude-opus-5-5",
  effort: "medium",
  maxSteps: 40,
});

export function AgentsPage() {
  const agents = useStore((s) => s.agents);
  const history = useStore((s) => s.history);
  const selected = useStore((s) => s.selectedAgentId);
  const meta = useStore((s) => s.meta);
  const catalog = useStore((s) => s.catalog);
  const current = agents.find((a) => a.id === selected);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (current) setDraft({ ...current });
  }, [current?.id, current?.version]);

  if (!meta || !catalog || !draft) return null;
  const dirty = !!current && (["name", "description", "provider", "model", "effort", "maxSteps"] as const).some((k) => draft[k] !== current[k]);
  const versions = history.filter((h) => h.id === current?.id).sort((a, b) => b.version - a.version);

  const save = async (andGenerate = false) => {
    setSaving(true);
    setError("");
    try {
      const a = await api.saveAgent(draft);
      selectAgent(a.id);
      if (andGenerate) go("tests/generate");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const setProvider = (p: AgentConfig["provider"]) =>
    setDraft({ ...draft, provider: p, model: p === "anthropic" ? meta.defaults.anthropic : p === "openai" ? meta.defaults.openai : "careful-controller" });

  return (
    <>
      <h1 className="page-title">Agent setup</h1>
      <p className="page-sub">Describe what your finance agent does. Ledger Lab splits that into capabilities, writes tests for each one, and runs the agent inside a simulated Bill Pay world where every action has consequences.</p>

      <div style={{ display: "grid", gridTemplateColumns: "280px minmax(0,1fr)", gap: 16, alignItems: "start" }}>
        <div className="card">
          <div className="spread card-pad" style={{ paddingBottom: 8 }}>
            <span className="section-title" style={{ margin: 0 }}>Agents</span>
            <button className="btn sm" onClick={() => { setDraft(blank(meta.defaults)); selectAgent(""); }}>New</button>
          </div>
          {agents.map((a) => (
            <div
              key={a.id}
              onClick={() => selectAgent(a.id)}
              style={{ padding: "10px 16px", borderTop: "1px solid var(--line)", cursor: "pointer", background: a.id === selected ? "var(--surface-2)" : undefined, boxShadow: a.id === selected ? "inset 3px 0 0 var(--ink)" : undefined }}
            >
              <div className="spread">
                <strong style={{ fontWeight: 600 }}>{a.name}</strong>
                <span className="muted small">v{a.version}</span>
              </div>
              <div style={{ marginTop: 4 }}><ProviderPill provider={a.provider} model={a.model} /></div>
            </div>
          ))}
        </div>

        <div className="col" style={{ gap: 16 }}>
          <div className="card card-pad">
            <div className="field">
              <label className="label">Name</label>
              <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="field">
              <label className="label">What does this agent do?</label>
              <textarea
                className="textarea"
                style={{ minHeight: 110 }}
                placeholder="e.g. Pays approved vendor bills every Friday, chases approvals, syncs to NetSuite, and handles vendor refund tickets."
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
              <div className="muted small" style={{ marginTop: 4 }}>This text becomes part of the agent's instructions and drives which tests get generated. It can describe more than one job.</div>
            </div>
            <div className="grid3">
              <div className="field">
                <label className="label">Runs on</label>
                <select className="select" value={draft.provider} onChange={(e) => setProvider(e.target.value as AgentConfig["provider"])}>
                  <option value="anthropic">Claude{meta.keys.anthropic ? "" : " (no key)"}</option>
                  <option value="openai">GPT / OpenRouter{meta.keys.openai ? "" : " (no key)"}</option>
                  <option value="scripted">Scripted (offline)</option>
                </select>
              </div>
              <div className="field">
                <label className="label">{draft.provider === "scripted" ? "Behavior" : "Model"}</label>
                {draft.provider === "scripted" ? (
                  <select className="select" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })}>
                    {Object.entries(meta.scripts).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                ) : (
                  <input className="input mono" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
                )}
              </div>
              <div className="field">
                <label className="label">{draft.provider === "anthropic" ? "Effort" : "Max steps"}</label>
                {draft.provider === "anthropic" ? (
                  <select className="select" value={draft.effort ?? "medium"} onChange={(e) => setDraft({ ...draft, effort: e.target.value as Draft["effort"] })}>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                ) : (
                  <input className="input" type="number" min={1} max={200} value={draft.maxSteps} onChange={(e) => setDraft({ ...draft, maxSteps: Number(e.target.value) })} />
                )}
              </div>
            </div>
            {draft.provider === "scripted" && <div className="notice" style={{ marginBottom: 12 }}>{meta.scripts[draft.model]?.blurb} Scripted agents ignore the description; they exist so the lab can be demoed without API keys.</div>}
            {draft.provider === "anthropic" && !meta.keys.anthropic && <div className="notice warn" style={{ marginBottom: 12 }}>Set ANTHROPIC_API_KEY before starting Ledger Lab to run this agent.</div>}
            {draft.provider === "openai" && !meta.keys.openai && <div className="notice warn" style={{ marginBottom: 12 }}>Set OPENAI_API_KEY before starting Ledger Lab to run this agent.</div>}
            {error && <div className="notice warn" style={{ marginBottom: 12 }}>{error}</div>}
            <div className="row">
              <button className="btn primary" disabled={saving || (!dirty && !!current)} onClick={() => save(false)}>
                {current ? (dirty ? `Save as v${current.version + 1}` : `Saved · v${current.version}`) : "Create agent"}
              </button>
              <button className="btn accent" disabled={saving || !draft.description.trim()} onClick={() => (dirty || !current ? save(true) : go("tests/generate"))}>
                Generate tests
              </button>
              <div className="grow" />
              {current && <button className="btn ghost danger sm" onClick={() => confirm(`Delete ${current.name}?`) && api.deleteAgent(current.id)}>Delete</button>}
            </div>
          </div>

          <ConnectAgent />

          <div className="card card-pad">
            <div className="section-title">Simulated environment</div>
            <div className="grid3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
              {catalog.worlds.map((w) => (
                <div key={w.id} className={`world-tile ${w.status === "ready" ? "on" : "locked"}`}>
                  <div className="spread">
                    <strong style={{ fontWeight: 600 }}>{w.name}</strong>
                    {w.status === "ready" ? <Pill tone="accent">Active</Pill> : <Pill>Planned</Pill>}
                  </div>
                  <div className="muted small" style={{ marginTop: 6 }}>{w.blurb}</div>
                </div>
              ))}
            </div>
          </div>

          {versions.length > 0 && (
            <div className="card card-pad">
              <div className="section-title">Earlier versions</div>
              {versions.map((v) => (
                <div key={v.version} className="spread" style={{ padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                  <span><strong>v{v.version}</strong> <span className="muted small">{v.model} · {new Date(v.updatedAt).toLocaleString()}</span></span>
                  <span className="muted small" style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.description}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
