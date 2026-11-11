import { useState } from "react";
import { useStore } from "../store";

/** Shows how to point an external agent at the simulated world over MCP. */
export function ConnectAgent() {
  const catalog = useStore((s) => s.catalog);
  const tests = useStore((s) => s.tests);
  const [target, setTarget] = useState("scenario:payment_timeout");
  const [name, setName] = useState("My AP agent");
  const [copied, setCopied] = useState("");
  if (!catalog) return null;

  const [kind, id] = target.split(":");
  const url = `${location.origin}/mcp?${kind}=${encodeURIComponent(id)}&agent=${encodeURIComponent(name)}`;
  const claude = `claude mcp add --transport http ledgerlab "${url}"`;
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setCopied("");
    }
  };

  return (
    <div className="card card-pad">
      <h3>Connect your own agent</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        Any agent that speaks MCP can be tested here. Each connection is a fresh copy of the Bill Pay world: it appears under Live run, takes your chaos and clock controls, and is graded on its report like any other run.
      </p>
      <div className="grid2" style={{ gap: 10 }}>
        <div className="field">
          <label className="label">Run</label>
          <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
            <optgroup label="Scenarios">
              {catalog.scenarios.map((s) => <option key={s.id} value={`scenario:${s.id}`}>{s.title}</option>)}
            </optgroup>
            {tests.length > 0 && (
              <optgroup label="Saved tests">
                {tests.map((t) => <option key={t.id} value={`test:${t.id}`}>{t.title}</option>)}
              </optgroup>
            )}
          </select>
        </div>
        <div className="field">
          <label className="label">Name in the dashboard</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <label className="label">MCP endpoint (Streamable HTTP)</label>
      <div className="row" style={{ marginBottom: 10 }}>
        <code className="input mono" style={{ overflowX: "auto", whiteSpace: "nowrap" }}>{url}</code>
        <button className="btn sm" onClick={() => copy(url, "url")}>{copied === "url" ? "Copied" : "Copy"}</button>
      </div>
      <label className="label">Claude Code</label>
      <div className="row">
        <code className="input mono" style={{ overflowX: "auto", whiteSpace: "nowrap" }}>{claude}</code>
        <button className="btn sm" onClick={() => copy(claude, "claude")}>{copied === "claude" ? "Copied" : "Copy"}</button>
      </div>
      <div className="muted small" style={{ marginTop: 8 }}>The agent should call <span className="kbd">get_task</span> first, then work through the tools and finish with <span className="kbd">submit_report</span>.</div>
    </div>
  );
}
