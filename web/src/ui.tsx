import type { ReactNode } from "react";
import type { RunSummary } from "./api";

export function Pill({ tone, children, title }: { tone?: "ok" | "bad" | "warn" | "info" | "chaos" | "accent"; children: ReactNode; title?: string }) {
  return (
    <span className={`pill ${tone ?? ""}`} title={title}>
      {children}
    </span>
  );
}

export function StatusPill({ run }: { run: Pick<RunSummary, "status" | "passed" | "caughtLie"> }) {
  if (run.status === "running") return <Pill tone="info"><span className="spin" style={{ width: 9, height: 9 }} /> Running</Pill>;
  if (run.status === "paused") return <Pill tone="warn">Paused</Pill>;
  if (run.status === "error") return <Pill tone="bad">Error</Pill>;
  if (run.status === "stopped") return <Pill>Stopped</Pill>;
  if (run.passed) return <Pill tone="ok"><span className="dot" /> Passed</Pill>;
  return <Pill tone="bad"><span className="dot" /> {run.caughtLie ? "Failed · report contradicted" : "Failed"}</Pill>;
}

export function ProviderPill({ provider, model }: { provider: string; model: string }) {
  // OpenRouter-style ids ("vendor/model") go through the OpenAI-compatible adapter.
  const label = provider === "anthropic" ? "Claude" : provider === "openai" ? (model.includes("/") ? "OpenRouter" : "GPT") : provider === "external" ? "External · MCP" : "Scripted";
  return (
    <Pill tone={provider === "scripted" ? undefined : "info"} title={model}>
      {label} · <span className="mono" style={{ fontSize: 11 }}>{model}</span>
    </Pill>
  );
}

export function Rate({ pass, total }: { pass: number; total: number }) {
  if (!total) return <span className="muted">—</span>;
  const r = pass / total;
  const tone = r === 1 ? "var(--ok-bg)" : r === 0 ? "var(--bad-bg)" : "var(--warn-bg)";
  const color = r === 1 ? "var(--ok)" : r === 0 ? "var(--bad)" : "var(--warn)";
  return (
    <span className="rate" style={{ background: tone, color }}>
      {pass}/{total}
    </span>
  );
}

/** "$0.0042" style, with enough precision for sub-cent runs. */
export function fmtCost(c: number | null | undefined): string {
  if (c === undefined) return "—";
  if (c === null) return "n/a";
  if (c === 0) return "$0";
  return c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
