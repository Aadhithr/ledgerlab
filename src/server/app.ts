import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { CHAOS } from "../engine/chaos.js";
import { TOOLS } from "../engine/tools.js";
import { stateAt } from "../engine/world.js";
import { CHECKS } from "../grader/checks.js";
import { RULE_KINDS } from "../grader/rules.js";
import { SCENARIOS, SCENARIO_MAP } from "../scenarios/library.js";
import { SCRIPTS } from "../agent/scripted.js";
import { anthropicAvailable, DEFAULT_CLAUDE_MODEL } from "../agent/anthropic.js";
import { openaiAvailable, DEFAULT_OPENAI_MODEL } from "../agent/openai.js";
import { generatePlan } from "../ai/generate.js";
import { labModel } from "../ai/llm.js";
import type { Lab, LabEvent } from "../lab/lab.js";
import type { TestDef } from "../lab/types.js";
import { WORLDS } from "./worlds.js";
import { createMcpHandler } from "./mcp.js";

const AgentInput = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(4000),
  provider: z.enum(["anthropic", "openai", "scripted"]),
  model: z.string().max(80),
  effort: z.enum(["low", "medium", "high"]).optional(),
  maxSteps: z.number().int().min(1).max(200).optional(),
});

const ControlInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chaos"), kind: z.string(), params: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal("advance_clock"), hours: z.number().positive().max(24 * 31) }),
  z.object({ type: z.enum(["pause", "resume", "step", "stop"]) }),
]);

const RunInput = z.object({
  agentId: z.string(),
  testIds: z.array(z.string()).optional(),
  scenarioId: z.string().optional(),
  repeat: z.number().int().min(1).max(25).optional(),
  paceMs: z.number().int().min(0).max(5000).optional(),
  startPaused: z.boolean().optional(),
  extraChaos: z.array(z.string()).optional(),
});

export function createApp(lab: Lab, webDir: string | null) {
  const app = new Hono();

  app.onError((err, c) => c.json({ error: err.message }, err instanceof z.ZodError ? 400 : 500));

  app.get("/api/meta", (c) =>
    c.json({
      keys: { anthropic: anthropicAvailable(), openai: openaiAvailable() },
      labModel: labModel(),
      defaults: { anthropic: DEFAULT_CLAUDE_MODEL, openai: DEFAULT_OPENAI_MODEL },
      scripts: SCRIPTS,
      dataDir: lab.store.dir,
    }),
  );

  app.get("/api/catalog", (c) =>
    c.json({
      worlds: WORLDS,
      scenarios: SCENARIOS.map(({ seed, ...s }) => s),
      chaos: CHAOS.map(({ apply, ...k }) => k),
      checks: CHECKS.map(({ run, ...k }) => k),
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
      ruleKinds: RULE_KINDS,
    }),
  );

  // Agents
  app.get("/api/agents", (c) => c.json({ agents: lab.agents, history: lab.agentHistory }));
  app.post("/api/agents", async (c) => c.json(lab.upsertAgent(AgentInput.parse(await c.req.json()))));
  app.delete("/api/agents/:id", (c) => {
    lab.deleteAgent(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Tests
  app.get("/api/tests", (c) => {
    const agentId = c.req.query("agentId");
    return c.json(lab.tests.filter((t) => !agentId || t.agentId === agentId));
  });
  app.post("/api/plan", async (c) => {
    const body = z.object({ agentId: z.string(), request: z.string().max(2000).optional(), rules: z.array(z.string().max(500)).max(20).optional(), replace: z.boolean().optional() }).parse(await c.req.json());
    const agent = lab.getAgent(body.agentId);
    const plan = await generatePlan({ agentId: agent.id, description: agent.description, request: body.request, rules: body.rules });
    if (body.replace) lab.deleteTests(lab.tests.filter((t) => t.agentId === agent.id && t.source !== "custom").map((t) => t.id));
    lab.addTests(plan.tests);
    return c.json(plan);
  });
  app.post("/api/tests", async (c) => {
    const body = z.object({ agentId: z.string(), scenarioId: z.string(), title: z.string().max(200).optional(), task: z.string().max(2000).optional(), extraChaos: z.array(z.string()).optional(), checks: z.array(z.string()).optional() }).parse(await c.req.json());
    const sc = SCENARIO_MAP.get(body.scenarioId);
    if (!sc) return c.json({ error: "unknown scenario" }, 400);
    const test: TestDef = {
      id: `test_${randomUUID().slice(0, 8)}`, agentId: body.agentId, title: body.title || sc.title, capability: "Custom", scenarioId: sc.id,
      extraChaos: (body.extraChaos ?? []).map((k) => ({ trigger: "start" as const, chaos: k })), checks: body.checks?.length ? body.checks : sc.checks,
      rules: [], task: body.task, rationale: "Added by hand.", source: "custom", createdAt: new Date().toISOString(),
    };
    lab.addTests([test]);
    return c.json(test);
  });
  app.patch("/api/tests/:id", async (c) => {
    const patch = z.object({ title: z.string().optional(), checks: z.array(z.string()).optional(), task: z.string().optional() }).parse(await c.req.json());
    lab.updateTest(c.req.param("id"), patch);
    return c.json({ ok: true });
  });
  app.delete("/api/tests/:id", (c) => {
    lab.deleteTests([c.req.param("id")]);
    return c.json({ ok: true });
  });

  // Runs
  app.post("/api/runs", async (c) => {
    const body = RunInput.parse(await c.req.json());
    let tests: TestDef[];
    if (body.testIds?.length) tests = lab.tests.filter((t) => body.testIds!.includes(t.id));
    else if (body.scenarioId) {
      const sc = SCENARIO_MAP.get(body.scenarioId);
      if (!sc) return c.json({ error: "unknown scenario" }, 400);
      tests = [{
        id: `adhoc_${sc.id}`, agentId: body.agentId, title: sc.title, capability: sc.capability, scenarioId: sc.id,
        extraChaos: (body.extraChaos ?? []).map((k) => ({ trigger: "start" as const, chaos: k })), checks: sc.checks, rules: [],
        rationale: sc.summary, source: "library", createdAt: new Date().toISOString(),
      }];
    } else return c.json({ error: "testIds or scenarioId required" }, 400);
    if (!tests.length) return c.json({ error: "no matching tests" }, 400);
    return c.json(lab.startRuns({ agentId: body.agentId, tests, repeat: body.repeat, paceMs: body.paceMs, startPaused: body.startPaused }));
  });
  app.get("/api/runs", (c) => c.json([...lab.runs.values()].map((r) => lab.summary(r)).reverse()));
  app.get("/api/runs/:id", (c) => {
    const r = lab.runs.get(c.req.param("id"));
    return r ? c.json({ ...r, summary: lab.summary(r) }) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/runs/:id/state", (c) => {
    const r = lab.runs.get(c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    const seq = Number(c.req.query("seq") ?? Number.MAX_SAFE_INTEGER);
    return c.json(stateAt(r.events, Number.isFinite(seq) ? seq : Number.MAX_SAFE_INTEGER));
  });
  app.post("/api/runs/:id/control", async (c) => {
    lab.control(c.req.param("id"), ControlInput.parse(await c.req.json()));
    return c.json({ ok: true });
  });
  app.post("/api/runs/:id/explain", async (c) => c.json(await lab.explain(c.req.param("id"))));
  app.post("/api/runs/:id/regrade", (c) => c.json(lab.summary(lab.regrade(c.req.param("id")))));
  app.get("/api/batches", (c) => c.json(lab.batches.slice().reverse()));

  // Bring your own agent over MCP (Streamable HTTP). Each session is one live run.
  const mcp = createMcpHandler(lab);
  app.all("/mcp", (c) => mcp(c.req.raw));

  // Live updates
  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      const queue: LabEvent[] = [];
      let wake: (() => void) | undefined;
      const onEvent = (e: LabEvent) => {
        queue.push(e);
        wake?.();
      };
      lab.on("lab", onEvent);
      stream.onAbort(() => {
        lab.off("lab", onEvent);
        wake?.();
      });
      await stream.writeSSE({ event: "hello", data: "{}" });
      while (!stream.aborted) {
        if (!queue.length) {
          await Promise.race([new Promise<void>((r) => (wake = r)), new Promise((r) => setTimeout(r, 15000))]);
          wake = undefined;
          if (!queue.length) await stream.writeSSE({ event: "ping", data: "{}" });
        }
        while (queue.length) await stream.writeSSE({ event: "lab", data: JSON.stringify(queue.shift()) });
      }
    }),
  );

  // Dashboard
  if (webDir && fs.existsSync(webDir)) {
    const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
    app.get("*", (c) => {
      const rel = decodeURIComponent(new URL(c.req.url).pathname).replace(/^\/+/, "");
      const file = path.resolve(webDir, rel || "index.html");
      const safe = file.startsWith(path.resolve(webDir)) && fs.existsSync(file) && fs.statSync(file).isFile();
      const target = safe ? file : path.join(webDir, "index.html");
      return c.body(fs.readFileSync(target), 200, { "content-type": types[path.extname(target)] ?? "application/octet-stream" });
    });
  }
  return app;
}
