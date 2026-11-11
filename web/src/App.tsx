import { useStore, useRoute, go } from "./store";
import { AgentsPage } from "./pages/Agents";
import { TestsPage } from "./pages/Tests";
import { RunPage } from "./pages/RunView";
import { ResultsPage } from "./pages/Results";
import { Pill } from "./ui";

const NAV = [
  { id: "agents", label: "Agent setup" },
  { id: "tests", label: "Test plan" },
  { id: "run", label: "Live run" },
  { id: "results", label: "Results" },
];

export function App() {
  const [page, arg] = useRoute();
  const meta = useStore((s) => s.meta);
  const connected = useStore((s) => s.connected);
  const runs = useStore((s) => s.runs);
  const tests = useStore((s) => s.tests);
  const agents = useStore((s) => s.agents);
  const selected = useStore((s) => s.selectedAgentId);
  const agent = agents.find((a) => a.id === selected);
  const live = runs.filter((r) => r.status === "running" || r.status === "paused").length;
  const latest = runs[0]?.id;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">L</div>
          Ledger Lab
        </div>
        <Pill>Bill Pay & AP world</Pill>
        <div className="grow" />
        {meta && (
          <div className="row small">
            <Pill tone={meta.keys.anthropic ? "ok" : undefined} title="ANTHROPIC_API_KEY">Claude API {meta.keys.anthropic ? "connected" : "no key"}</Pill>
            <Pill tone={meta.keys.openai ? "ok" : undefined} title="OPENAI_API_KEY">OpenAI-compatible {meta.keys.openai ? "connected" : "no key"}</Pill>
          </div>
        )}
        <Pill tone={connected ? "ok" : "warn"}>
          <span className="dot" /> {connected ? "Live" : "Connecting"}
        </Pill>
      </header>
      <nav className="side">
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`nav ${page === n.id ? "active" : ""}`}
            onClick={() => go(n.id === "run" ? `run/${arg && page === "run" ? arg : latest ?? ""}` : n.id)}
          >
            {n.label}
            {n.id === "tests" && <span className="count">{tests.filter((t) => t.agentId === selected).length}</span>}
            {n.id === "run" && live > 0 && <span className="count">{live} live</span>}
            {n.id === "results" && <span className="count">{runs.length}</span>}
          </button>
        ))}
        <h6>Agent under test</h6>
        <div className="small" style={{ padding: "0 10px" }}>
          {agent ? (
            <>
              <div style={{ fontWeight: 600 }}>{agent.name}</div>
              <div className="muted">v{agent.version} · {agent.provider}</div>
            </>
          ) : (
            <span className="muted">None selected</span>
          )}
        </div>
      </nav>
      <main className="main">
        {page === "agents" && <AgentsPage />}
        {page === "tests" && <TestsPage autoGenerate={arg === "generate"} />}
        {page === "run" && <RunPage runId={arg} />}
        {page === "results" && <ResultsPage />}
      </main>
    </div>
  );
}
