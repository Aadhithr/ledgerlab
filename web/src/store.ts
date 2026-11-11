import { useEffect, useState, useSyncExternalStore } from "react";
import { api, type AgentConfig, type Catalog, type LabEvent, type Meta, type RunSummary, type TestDef, type WorldEvent } from "./api";

/** One small global store fed by REST on load and SSE afterwards. */
interface State {
  meta?: Meta;
  catalog?: Catalog;
  agents: AgentConfig[];
  history: AgentConfig[];
  tests: TestDef[];
  runs: RunSummary[];
  selectedAgentId?: string;
  connected: boolean;
}

let state: State = { agents: [], history: [], tests: [], runs: [], connected: false };
const listeners = new Set<() => void>();
const eventListeners = new Set<(runId: string, ev: WorldEvent) => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => sel(state),
  );
}

export const getState = () => state;

export function selectAgent(id: string) {
  set({ selectedAgentId: id });
  try {
    localStorage.setItem("ll.agent", id);
  } catch {
    /* storage unavailable */
  }
}

export async function refreshAgents() {
  const a = await api.agents();
  let sel = state.selectedAgentId;
  try {
    sel ??= localStorage.getItem("ll.agent") ?? undefined;
  } catch {
    /* storage unavailable */
  }
  if (!sel || !a.agents.some((x) => x.id === sel)) sel = a.agents[0]?.id;
  set({ agents: a.agents, history: a.history, selectedAgentId: sel });
}

export async function refreshTests() {
  set({ tests: await api.tests() });
}

export async function refreshRuns() {
  set({ runs: await api.runs() });
}

export async function boot() {
  const [meta, catalog] = await Promise.all([api.meta(), api.catalog()]);
  set({ meta, catalog });
  await Promise.all([refreshAgents(), refreshTests(), refreshRuns()]);
  connect();
}

function connect() {
  const es = new EventSource("/api/stream");
  es.addEventListener("hello", () => set({ connected: true }));
  es.addEventListener("lab", (m) => {
    const e = JSON.parse((m as MessageEvent).data) as LabEvent;
    if (e.type === "run.event") for (const l of eventListeners) l(e.runId, e.event);
    else if (e.type === "run.update") {
      const others = state.runs.filter((r) => r.id !== e.run.id);
      set({ runs: [e.run, ...others].sort((a, b) => b.startedAt.localeCompare(a.startedAt)) });
    } else if (e.type === "agents.update") void refreshAgents();
    else if (e.type === "tests.update") void refreshTests();
  });
  es.onerror = () => set({ connected: false });
}

/** Subscribe to live world events for one run. */
export function useRunEvents(runId: string | undefined, onEvent: (ev: WorldEvent) => void) {
  useEffect(() => {
    if (!runId) return;
    const l = (id: string, ev: WorldEvent) => id === runId && onEvent(ev);
    eventListeners.add(l);
    return () => {
      eventListeners.delete(l);
    };
  }, [runId, onEvent]);
}

/** Minimal hash router: #/page/arg */
export function useRoute(): [string, string | undefined] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const h = () => setHash(location.hash);
    addEventListener("hashchange", h);
    return () => removeEventListener("hashchange", h);
  }, []);
  const [, page = "agents", arg] = hash.split("/");
  return [page, arg];
}

export const go = (path: string) => {
  location.hash = `#/${path}`;
};
