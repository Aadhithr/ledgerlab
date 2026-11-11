import type { AgentConfig } from "../agent/types.js";
import type { WorldEvent } from "../engine/types.js";
import type { Grade } from "../grader/grade.js";
import type { CustomRule } from "../grader/rules.js";
import type { TimelineStep } from "../scenarios/library.js";
import type { RunOutcome } from "../agent/runner.js";

/** A runnable test: a scenario, extra exceptions layered on top, and the checks that decide pass or fail. */
export interface TestDef {
  id: string;
  agentId: string;
  title: string;
  capability: string;
  scenarioId: string;
  extraChaos: TimelineStep[];
  checks: string[];
  rules: CustomRule[];
  /** Overrides the scenario's task when the user described a specific job. */
  task?: string;
  rationale: string;
  source: "library" | "generated" | "custom";
  createdAt: string;
}

export interface RunRecord {
  id: string;
  testId?: string;
  testTitle: string;
  scenarioId: string;
  batchId?: string;
  index: number;
  agent: AgentConfig;
  status: "running" | "paused" | "done" | "error" | "stopped";
  events: WorldEvent[];
  grade?: Grade;
  outcome?: RunOutcome;
  explanation?: Explanation;
  startedAt: string;
  finishedAt?: string;
}

export interface Explanation {
  source: "template" | "ai";
  headline: string;
  explanation: string;
  rootCause?: string;
  suggestedInstruction?: string;
}

export interface BatchRecord {
  id: string;
  label: string;
  runIds: string[];
  createdAt: string;
}
