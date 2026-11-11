import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Lab } from "../src/lab/lab.js";
import { seedDemo } from "../src/lab/demo.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerlab-demo-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("demo mode", () => {
  it("preloads the runs the demo video needs, offline", async () => {
    const lab = new Lab(dir);
    expect(await seedDemo(lab)).toBe(true);
    const runs = [...lab.runs.values()];
    const done = runs.filter((r) => r.status === "done");
    expect(done.length).toBe(runs.length);

    const trap = runs.find((r) => r.agent.id === "agent_intern" && r.scenarioId === "payment_timeout" && !r.batchId)!;
    expect(trap.grade!.caughtLie).toBe(true);

    const rate = (pred: (r: (typeof runs)[number]) => boolean) => {
      const rs = done.filter(pred);
      return `${rs.filter((r) => r.grade!.passed).length}/${rs.length}`;
    };
    const v1 = done.filter((r) => r.agent.id === "agent_controller" && r.agent.version === 1);
    expect(v1.filter((r) => !r.grade!.passed).every((r) => r.scenarioId === "sync_failure")).toBe(true);
    expect(rate((r) => r.agent.id === "agent_controller" && r.agent.version === 2)).toMatch(/^(\d+)\/\1$/);
    expect(lab.batches.map((b) => b.label)).toEqual(["Eager intern v1: full suite x5", "Careful controller v1: full suite x5", "Careful controller v2: full suite x5"]);
  });

  it("leaves an already prepared lab alone", async () => {
    const lab = new Lab(dir);
    const before = lab.runs.size;
    expect(await seedDemo(lab)).toBe(false);
    expect(lab.runs.size).toBe(before);
  });
});
