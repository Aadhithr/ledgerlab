import type { AgentConfig } from "../../src/agent/types";
import type { WorldEvent, WorldState } from "../../src/engine/types";
import type { RunRecord, TestDef, Explanation, BatchRecord } from "../../src/lab/types";
import type { RunSummary, LabEvent } from "../../src/lab/lab";
import type { Scenario } from "../../src/scenarios/library";
import type { PlanResult } from "../../src/ai/generate";

export type { AgentConfig, WorldEvent, WorldState, RunRecord, TestDef, Explanation, RunSummary, LabEvent, BatchRecord, PlanResult };

export interface Meta {
  keys: { anthropic: boolean; openai: boolean };
  labModel: { provider: string; model: string } | null;
  defaults: { anthropic: string; openai: string };
  scripts: Record<string, { label: string; blurb: string }>;
  dataDir: string;
}

export interface Catalog {
  worlds: { id: string; name: string; status: "ready" | "planned"; blurb: string; objects: string[] }[];
  scenarios: Omit<Scenario, "seed">[];
  chaos: { kind: string; label: string; description: string }[];
  checks: { id: string; name: string; description: string; severity: string }[];
  tools: { name: string; description: string }[];
  ruleKinds: { kind: string; help: string }[];
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  meta: () => call<Meta>("GET", "/api/meta"),
  catalog: () => call<Catalog>("GET", "/api/catalog"),
  agents: () => call<{ agents: AgentConfig[]; history: AgentConfig[] }>("GET", "/api/agents"),
  saveAgent: (a: Partial<AgentConfig>) => call<AgentConfig>("POST", "/api/agents", a),
  deleteAgent: (id: string) => call("DELETE", `/api/agents/${id}`),
  tests: (agentId?: string) => call<TestDef[]>("GET", `/api/tests${agentId ? `?agentId=${agentId}` : ""}`),
  plan: (b: { agentId: string; request?: string; rules?: string[]; replace?: boolean }) => call<PlanResult>("POST", "/api/plan", b),
  addTest: (b: { agentId: string; scenarioId: string; title?: string; task?: string; extraChaos?: string[] }) => call<TestDef>("POST", "/api/tests", b),
  deleteTest: (id: string) => call("DELETE", `/api/tests/${id}`),
  startRuns: (b: { agentId: string; testIds?: string[]; scenarioId?: string; repeat?: number; paceMs?: number; startPaused?: boolean }) =>
    call<{ runIds: string[]; batchId?: string }>("POST", "/api/runs", b),
  runs: () => call<RunSummary[]>("GET", "/api/runs"),
  run: (id: string) => call<RunRecord & { summary: RunSummary }>("GET", `/api/runs/${id}`),
  control: (id: string, action: Record<string, unknown>) => call("POST", `/api/runs/${id}/control`, action),
  explain: (id: string) => call<Explanation>("POST", `/api/runs/${id}/explain`),
  batches: () => call<BatchRecord[]>("GET", "/api/batches"),
};

export const usd = (c: number | undefined) =>
  c === undefined ? "—" : (c < 0 ? "-$" : "$") + (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const simTime = (t: number) => {
  const d = new Date(t);
  return d.toLocaleString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
};
