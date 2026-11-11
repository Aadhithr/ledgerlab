#!/usr/bin/env node
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Lab } from "./lab/lab.js";
import { createApp } from "./server/app.js";
import { runHeadless, scriptedAgent } from "./lab/headless.js";
import { seedDemo } from "./lab/demo.js";
import { SCENARIOS } from "./scenarios/library.js";
import { fmtUsd } from "./engine/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* no browser available; the URL is printed anyway */
  }
}

async function start(demo = false) {
  const port = Number(arg("port", process.env.PORT ?? "4417"));
  const defaultDir = demo ? ".ledgerlab-demo" : process.env.LEDGERLAB_HOME ?? ".ledgerlab";
  const dataDir = path.resolve(arg("data", path.join(process.cwd(), defaultDir))!);
  const lab = new Lab(dataDir);
  if (demo) {
    process.stdout.write("  Preparing demo data (scripted agents, offline)... ");
    const seeded = await seedDemo(lab);
    console.log(seeded ? `done, ${lab.runs.size} runs.` : "already prepared. Delete the folder to start over.");
  }
  const webDir = path.resolve(here, "web");
  const app = createApp(lab, webDir);
  serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  Ledger Lab is running at ${url}`);
    console.log(`  Data: ${dataDir}`);
    console.log(`  Anthropic key: ${process.env.ANTHROPIC_API_KEY ? "found" : "not set"}   OpenAI key: ${process.env.OPENAI_API_KEY ? "found" : "not set"}\n`);
    if (!flag("no-open")) openBrowser(url);
  });
}

/** CI mode: run scripted or LLM agents headless and exit non-zero on failure. */
async function runCi() {
  const script = arg("agent", "careful-controller-v2")!;
  const only = arg("scenario");
  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  let failures = 0;
  for (const sc of scenarios) {
    const { grade } = await runHeadless({ scenarioId: sc.id, agent: scriptedAgent(script) });
    const failed = grade.checks.filter((c) => !c.passed);
    failures += failed.length ? 1 : 0;
    console.log(`${failed.length ? "FAIL" : "PASS"}  ${sc.id.padEnd(22)} ${failed.length ? `${failed.map((c) => c.id).join(", ")}  (${fmtUsd(grade.dollarsAtRisk)} at risk)` : ""}`);
  }
  console.log(`\n${scenarios.length - failures}/${scenarios.length} scenarios passed`);
  process.exit(failures ? 1 : 0);
}

const cmd = process.argv[2] ?? "start";
if (cmd === "start") void start();
else if (cmd === "demo") void start(true);
else if (cmd === "ci") void runCi();
else {
  console.log(
    "Usage: ledgerlab [start] [--port 4417] [--data ./.ledgerlab] [--no-open]\n" +
      "       ledgerlab demo [--port 4417]     start with preloaded demo runs in ./.ledgerlab-demo\n" +
      "       ledgerlab ci [--agent eager-intern|careful-controller|careful-controller-v2] [--scenario id]",
  );
  process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
}
