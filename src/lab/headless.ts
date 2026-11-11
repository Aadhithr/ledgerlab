import { World } from "../engine/world.js";
import { grade, type Grade } from "../grader/grade.js";
import type { CustomRule } from "../grader/rules.js";
import { runAgent, type RunOutcome } from "../agent/runner.js";
import type { AgentConfig } from "../agent/types.js";
import { SCENARIO_MAP, type TimelineStep } from "../scenarios/library.js";

export function scriptedAgent(script: string): AgentConfig {
  return { id: script, name: script, description: "Pays approved bills.", provider: "scripted", model: script, version: 1, maxSteps: 80, updatedAt: "" };
}

/** Run one scenario to completion with no server and return the world and grade. */
export async function runHeadless(opts: {
  scenarioId: string;
  agent: AgentConfig;
  seed?: number;
  rules?: CustomRule[];
  extraTimeline?: TimelineStep[];
  checks?: string[];
}): Promise<{ world: World; grade: Grade; outcome: RunOutcome }> {
  const sc = SCENARIO_MAP.get(opts.scenarioId);
  if (!sc) throw new Error(`unknown scenario ${opts.scenarioId}`);
  const world = new World(sc.seed());
  const outcome = await runAgent({ world, scenario: sc, agent: opts.agent, seed: opts.seed, extraTimeline: opts.extraTimeline });
  return { world, outcome, grade: grade(world.events, opts.checks ?? sc.checks, sc.expect, opts.rules) };
}
