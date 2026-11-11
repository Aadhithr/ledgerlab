import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { World } from "../engine/world.js";
import { grade } from "../grader/grade.js";
import { RunControl, RunHarness, runAgent, type ControlAction, type RunOutcome } from "../agent/runner.js";
import type { AgentConfig } from "../agent/types.js";
import { DEFAULT_CLAUDE_MODEL } from "../agent/anthropic.js";
import { DEFAULT_OPENAI_MODEL } from "../agent/openai.js";
import { SCENARIO_MAP } from "../scenarios/library.js";
import { templateExplanation, aiExplanation } from "../ai/explain.js";
import type { WorldEvent, WorldState } from "../engine/types.js";
import { Store } from "./store.js";
import type { BatchRecord, RunRecord, TestDef } from "./types.js";

export type LabEvent =
  | { type: "run.event"; runId: string; event: WorldEvent }
  | { type: "run.update"; run: RunSummary }
  | { type: "agents.update" }
  | { type: "tests.update" };

export interface RunSummary {
  id: string;
  testId?: string;
  testTitle: string;
  scenarioId: string;
  batchId?: string;
  index: number;
  agentId: string;
  agentName: string;
  version: number;
  provider: string;
  model: string;
  status: RunRecord["status"];
  passed?: boolean;
  score?: number;
  dollarsAtRisk?: number;
  caughtLie?: boolean;
  failedChecks: string[];
  checkResults: Record<string, boolean>;
  steps?: number;
  endedBy?: string;
  costUsd?: number | null;
  tokens?: number;
  startedAt: string;
}

const DEFAULT_DESCRIPTION =
  "Runs weekly accounts payable for Northwind Robotics: pays approved vendor bills on time, gets approvals when needed, keeps the general ledger in sync, catches duplicate or fraudulent invoices, and handles vendor refund tickets.";

function defaultAgents(): AgentConfig[] {
  const now = new Date().toISOString();
  const base = { description: DEFAULT_DESCRIPTION, version: 1, maxSteps: 40, updatedAt: now };
  return [
    { ...base, id: "agent_claude", name: "AP Copilot (Claude)", provider: "anthropic", model: DEFAULT_CLAUDE_MODEL, effort: "medium" },
    { ...base, id: "agent_gpt", name: "AP Copilot (GPT)", provider: "openai", model: DEFAULT_OPENAI_MODEL },
    { ...base, id: "agent_intern", name: "Eager intern", provider: "scripted", model: "eager-intern", maxSteps: 80 },
    { ...base, id: "agent_controller", name: "Careful controller", provider: "scripted", model: "careful-controller", maxSteps: 80 },
  ];
}

export class Lab extends EventEmitter {
  readonly store: Store;
  agents: AgentConfig[];
  agentHistory: AgentConfig[];
  tests: TestDef[];
  runs = new Map<string, RunRecord>();
  batches: BatchRecord[];
  private controls = new Map<string, RunControl>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    super();
    this.setMaxListeners(100);
    this.store = new Store(dataDir);
    const a = this.store.loadAgents();
    this.agents = a.current.length ? a.current : defaultAgents();
    this.agentHistory = a.history;
    if (!a.current.length) this.store.saveAgents({ current: this.agents, history: [] });
    this.tests = this.store.loadTests();
    this.batches = this.store.loadBatches();
    for (const r of this.store.loadRuns()) {
      if (r.status === "running" || r.status === "paused") r.status = "stopped";
      this.runs.set(r.id, r);
    }
  }

  private broadcast(e: LabEvent) {
    this.emit("lab", e);
  }

  // ---- agents ----
  getAgent(id: string) {
    const a = this.agents.find((x) => x.id === id);
    if (!a) throw new Error(`agent ${id} not found`);
    return a;
  }

  upsertAgent(input: Partial<AgentConfig> & { name: string }): AgentConfig {
    const existing = input.id ? this.agents.find((a) => a.id === input.id) : undefined;
    let agent: AgentConfig;
    if (existing) {
      const changed = (["description", "provider", "model", "effort", "maxSteps"] as const).some((k) => input[k] !== undefined && input[k] !== existing[k]);
      if (changed) this.agentHistory.push({ ...existing });
      agent = { ...existing, ...input, version: changed ? existing.version + 1 : existing.version, updatedAt: new Date().toISOString() } as AgentConfig;
      this.agents = this.agents.map((a) => (a.id === agent.id ? agent : a));
    } else {
      agent = {
        id: `agent_${randomUUID().slice(0, 8)}`,
        description: DEFAULT_DESCRIPTION,
        provider: "anthropic",
        model: DEFAULT_CLAUDE_MODEL,
        maxSteps: 40,
        ...input,
        version: 1,
        updatedAt: new Date().toISOString(),
      } as AgentConfig;
      this.agents.push(agent);
    }
    this.store.saveAgents({ current: this.agents, history: this.agentHistory });
    this.broadcast({ type: "agents.update" });
    return agent;
  }

  deleteAgent(id: string) {
    this.agents = this.agents.filter((a) => a.id !== id);
    this.store.saveAgents({ current: this.agents, history: this.agentHistory });
    this.broadcast({ type: "agents.update" });
  }

  // ---- tests ----
  addTests(tests: TestDef[]) {
    this.tests.push(...tests);
    this.store.saveTests(this.tests);
    this.broadcast({ type: "tests.update" });
  }

  updateTest(id: string, patch: Partial<TestDef>) {
    this.tests = this.tests.map((t) => (t.id === id ? { ...t, ...patch, id } : t));
    this.store.saveTests(this.tests);
    this.broadcast({ type: "tests.update" });
  }

  deleteTests(ids: string[]) {
    const s = new Set(ids);
    this.tests = this.tests.filter((t) => !s.has(t.id));
    this.store.saveTests(this.tests);
    this.broadcast({ type: "tests.update" });
  }

  // ---- runs ----
  summary(r: RunRecord): RunSummary {
    const checkResults: Record<string, boolean> = {};
    for (const c of r.grade?.checks ?? []) checkResults[c.id] = c.passed;
    return {
      id: r.id, testId: r.testId, testTitle: r.testTitle, scenarioId: r.scenarioId, batchId: r.batchId, index: r.index,
      agentId: r.agent.id, agentName: r.agent.name, version: r.agent.version, provider: r.agent.provider, model: r.agent.model,
      status: r.status, passed: r.grade?.passed, score: r.grade?.score, dollarsAtRisk: r.grade?.dollarsAtRisk,
      caughtLie: r.grade?.caughtLie, failedChecks: (r.grade?.checks ?? []).filter((c) => !c.passed).map((c) => c.id), checkResults,
      steps: r.outcome?.steps, endedBy: r.outcome?.endedBy, startedAt: r.startedAt,
      costUsd: r.outcome?.usage?.costUsd, tokens: r.outcome?.usage ? r.outcome.usage.inputTokens + r.outcome.usage.outputTokens : undefined,
    };
  }

  /**
   * Start runs. With repeat > 1 or several tests, they form a batch.
   * Scripted agents run back to back; LLM agents run through a queue to keep rate limits sane.
   */
  startRuns(opts: { agentId: string; tests: TestDef[]; repeat?: number; paceMs?: number; startPaused?: boolean; label?: string }): { runIds: string[]; batchId?: string } {
    const agent = { ...this.getAgent(opts.agentId) };
    const repeat = Math.max(1, Math.min(opts.repeat ?? 1, 25));
    const runIds: string[] = [];
    const batchId = opts.tests.length * repeat > 1 ? `batch_${randomUUID().slice(0, 8)}` : undefined;
    for (const test of opts.tests) {
      for (let i = 0; i < repeat; i++) {
        const id = `run_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`;
        const rec: RunRecord = {
          id, testId: test.id, testTitle: test.title, scenarioId: test.scenarioId, batchId, index: i, agent,
          status: opts.startPaused ? "paused" : "running", events: [], startedAt: new Date().toISOString(),
        };
        this.runs.set(id, rec);
        runIds.push(id);
        const control = new RunControl();
        if (opts.startPaused) control.paused = true;
        this.controls.set(id, control);
        this.broadcast({ type: "run.update", run: this.summary(rec) });
        const exec = () => this.execute(rec, test, control, i, opts.paceMs);
        if (agent.provider === "scripted" && !opts.paceMs && !opts.startPaused) void exec();
        else if (runIds.length === 1 && repeat * opts.tests.length === 1) void exec();
        else this.queue = this.queue.then(exec, exec);
      }
    }
    if (batchId) {
      this.batches.push({ id: batchId, label: opts.label ?? `${agent.name} v${agent.version}: ${opts.tests.length} test(s) x${repeat}`, runIds, createdAt: new Date().toISOString() });
      this.store.saveBatches(this.batches);
    }
    return { runIds, batchId };
  }

  private async execute(rec: RunRecord, test: TestDef, control: RunControl, index: number, paceMs?: number) {
    const sc = SCENARIO_MAP.get(test.scenarioId);
    if (!sc) {
      rec.status = "error";
      this.broadcast({ type: "run.update", run: this.summary(rec) });
      return;
    }
    const { world, off } = this.attachWorld(rec, sc.seed());
    let outcome: RunOutcome;
    try {
      outcome = await runAgent({ world, scenario: sc, agent: rec.agent, extraTimeline: test.extraChaos, task: test.task, control, seed: index + 1, paceMs });
    } catch (e) {
      outcome = { steps: 0, endedBy: "error", error: e instanceof Error ? e.message : String(e) };
    } finally {
      off();
    }
    this.finishRun(rec, test, world, outcome);
  }

  /** Create a world for a run and stream every event in it to the dashboard. */
  private attachWorld(rec: RunRecord, seed: WorldState) {
    const world = new World(seed);
    rec.events = world.events;
    for (const ev of world.events) this.broadcast({ type: "run.event", runId: rec.id, event: ev });
    const off = world.onEvent((ev) => this.broadcast({ type: "run.event", runId: rec.id, event: ev }));
    return { world, off };
  }

  /** Grade, save and announce a finished run. The same path for built-in and external agents. */
  private finishRun(rec: RunRecord, test: TestDef, world: World, outcome: RunOutcome) {
    const sc = SCENARIO_MAP.get(test.scenarioId)!;
    rec.outcome = outcome;
    rec.status = outcome.endedBy === "stopped" ? "stopped" : outcome.endedBy === "error" ? "error" : "done";
    rec.events = [...world.events];
    rec.grade = grade(rec.events, test.checks, sc.expect, test.rules);
    rec.explanation = templateExplanation(rec);
    rec.finishedAt = new Date().toISOString();
    this.controls.delete(rec.id);
    this.store.saveRun(rec);
    this.broadcast({ type: "run.update", run: this.summary(rec) });
  }

  /**
   * Open a live run for an agent the lab does not drive (it connects over MCP).
   * The caller performs tool calls through the returned harness and calls finish().
   */
  startExternalRun(opts: { test: TestDef; agentName: string; agentModel?: string }) {
    const sc = SCENARIO_MAP.get(opts.test.scenarioId);
    if (!sc) throw new Error(`unknown scenario ${opts.test.scenarioId}`);
    const agent: AgentConfig = {
      id: `external_${opts.agentName.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40)}`,
      name: opts.agentName,
      description: "External agent connected over MCP.",
      provider: "external",
      model: opts.agentModel ?? "mcp",
      version: 1,
      maxSteps: 0,
      updatedAt: new Date().toISOString(),
    };
    const rec: RunRecord = {
      id: `run_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`, testId: opts.test.id, testTitle: opts.test.title,
      scenarioId: sc.id, index: 0, agent, status: "running", events: [], startedAt: new Date().toISOString(),
    };
    this.runs.set(rec.id, rec);
    const control = new RunControl();
    this.controls.set(rec.id, control);
    const { world, off } = this.attachWorld(rec, sc.seed());
    const harness = new RunHarness(world, sc, opts.test.extraChaos, control);
    harness.start(`Run started: external agent "${agent.name}" connected over MCP on "${sc.title}"`);
    this.broadcast({ type: "run.update", run: this.summary(rec) });
    let steps = 0;
    let finished = false;
    return {
      rec,
      harness,
      task: opts.test.task ?? sc.task,
      countStep: () => steps++,
      finish: (endedBy: RunOutcome["endedBy"]) => {
        if (finished) return;
        finished = true;
        off();
        this.finishRun(rec, opts.test, world, { steps, endedBy });
      },
    };
  }

  control(runId: string, action: ControlAction) {
    const c = this.controls.get(runId);
    const rec = this.runs.get(runId);
    if (!c || !rec) throw new Error("run is not live");
    c.push(action);
    if (action.type === "pause") rec.status = "paused";
    if (action.type === "resume") rec.status = "running";
    this.broadcast({ type: "run.update", run: this.summary(rec) });
  }

  async explain(runId: string) {
    const rec = this.runs.get(runId);
    if (!rec) throw new Error("run not found");
    rec.explanation = await aiExplanation(rec);
    this.store.saveRun(rec);
    return rec.explanation;
  }

  /** Re-grade a saved run with the current checks. Replays the stored events, no agent involved. */
  regrade(runId: string) {
    const rec = this.runs.get(runId);
    if (!rec) throw new Error("run not found");
    const test = this.tests.find((t) => t.id === rec.testId);
    const sc = SCENARIO_MAP.get(rec.scenarioId)!;
    rec.grade = grade(rec.events, test?.checks ?? sc.checks, sc.expect, test?.rules ?? []);
    rec.explanation = templateExplanation(rec);
    this.store.saveRun(rec);
    this.broadcast({ type: "run.update", run: this.summary(rec) });
    return rec;
  }
}
