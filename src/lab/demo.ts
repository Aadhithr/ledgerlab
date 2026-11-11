import { generatePlan } from "../ai/generate.js";
import type { Lab } from "./lab.js";

/** Wait until every listed run has left the running state. */
export async function waitForRuns(lab: Lab, ids: string[], timeoutMs = 60_000) {
  const start = Date.now();
  while (ids.some((id) => ["running", "paused"].includes(lab.runs.get(id)?.status ?? ""))) {
    if (Date.now() - start > timeoutMs) throw new Error("demo seeding timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Preload a lab with the runs a demo needs. Uses only the scripted agents and
 * keyword test generation, so it is free, offline and the same every time.
 * Does nothing if the lab already has runs.
 */
export async function seedDemo(lab: Lab): Promise<boolean> {
  if (lab.runs.size > 0) return false;
  const intern = lab.agents.find((a) => a.id === "agent_intern");
  const controller = lab.agents.find((a) => a.id === "agent_controller");
  if (!intern || !controller) return false;

  for (const agent of [intern, controller]) {
    const plan = await generatePlan({ agentId: agent.id, description: agent.description, offline: true });
    lab.addTests(plan.tests);
  }
  const testsFor = (agentId: string) => lab.tests.filter((t) => t.agentId === agentId);

  // The timeout trap on its own first, so "catch the lie" has a single clear run to open.
  const trap = testsFor(intern.id).find((t) => t.scenarioId === "payment_timeout");
  if (trap) await waitForRuns(lab, lab.startRuns({ agentId: intern.id, tests: [trap] }).runIds);

  await waitForRuns(lab, lab.startRuns({ agentId: intern.id, tests: testsFor(intern.id), repeat: 5, label: "Eager intern v1: full suite x5" }).runIds);
  await waitForRuns(lab, lab.startRuns({ agentId: controller.id, tests: testsFor(controller.id), repeat: 5, label: "Careful controller v1: full suite x5" }).runIds);

  // The fix: v2 retries failed accounting syncs. Same tests, new version, compared side by side in Results.
  lab.upsertAgent({ ...controller, model: "careful-controller-v2", description: `${controller.description} Retry failed accounting syncs up to three times.` });
  await waitForRuns(lab, lab.startRuns({ agentId: controller.id, tests: testsFor(controller.id), repeat: 5, label: "Careful controller v2: full suite x5" }).runIds);
  return true;
}
