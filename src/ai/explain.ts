import { z } from "zod";
import { fmtUsd } from "../engine/types.js";
import type { Explanation, RunRecord } from "../lab/types.js";
import { structured } from "./llm.js";

/** Deterministic explanation built from the grade. Always available, no model needed. */
export function templateExplanation(run: RunRecord): Explanation {
  const g = run.grade;
  if (!g) return { source: "template", headline: "Not graded yet", explanation: "" };
  const failed = g.checks.filter((c) => !c.passed);
  if (failed.length === 0) {
    return { source: "template", headline: "All checks passed", explanation: `${run.agent.name} completed "${run.testTitle}" and every claim in its report matched the records.` };
  }
  const lie = g.reconciliation.filter((r) => !r.match);
  const headline = lie.length
    ? `The report says one thing; the records say another`
    : `${failed.length} check${failed.length > 1 ? "s" : ""} failed, ${fmtUsd(g.dollarsAtRisk)} at risk`;
  // The reconciliation lines below already state report mismatches, so skip that check's duplicate wording.
  const lines = failed
    .filter((c) => !(lie.length && c.id === "report_matches_records"))
    .flatMap((c) => c.findings.slice(0, 2).map((f) => `• ${c.name}: ${f.message}`));
  if (lie.length) lines.unshift(...lie.slice(0, 2).map((r) => `• ${r.item}: reported "${r.claimed}", actually "${r.actual}".`));
  return { source: "template", headline, explanation: [...new Set(lines)].join("\n") };
}

const ExplainSchema = z.object({
  headline: z.string().describe("Under 12 words, plain English"),
  explanation: z.string().describe("3-5 sentences: what happened, in order, citing event numbers like #42"),
  rootCause: z.string().describe("One sentence on the agent behavior that caused the failure"),
  suggestedInstruction: z.string().describe("One or two sentences to add to the agent's description that would prevent this. Written as an instruction to the agent."),
});

function condensedLog(run: RunRecord): string {
  return run.events
    .filter((e) => ["agent.tool_call", "agent.message", "chaos.injected", "clock.advanced", "payment.created", "agent.report", "run.note"].includes(e.type))
    .map((e) => {
      const t = new Date(e.at).toISOString().slice(5, 16).replace("T", " ");
      const d = e.data as Record<string, unknown>;
      if (e.type === "agent.tool_call") return `#${e.seq} ${t} TOOL ${d.tool}(${JSON.stringify(d.input)}) -> ${d.isError ? "ERROR " : ""}${String(d.output).slice(0, 220)}`;
      if (e.type === "agent.message") return `#${e.seq} ${t} AGENT SAYS: ${String(d.text).slice(0, 300)}`;
      if (e.type === "agent.report") return `#${e.seq} ${t} REPORT ${JSON.stringify(d.report).slice(0, 900)}`;
      return `#${e.seq} ${t} ${e.type.toUpperCase()} ${JSON.stringify(d).slice(0, 200)}`;
    })
    .join("\n");
}

/** Ask the lab model to explain a failed run and propose an instruction fix. Falls back to the template. */
export async function aiExplanation(run: RunRecord): Promise<Explanation> {
  const g = run.grade;
  if (!g) return templateExplanation(run);
  const failures = g.checks.filter((c) => !c.passed).map((c) => ({ check: c.name, findings: c.findings.map((f) => `${f.message} (events ${f.seqs.map((s) => "#" + s).join(", ") || "n/a"})`) }));
  const user = [
    `Agent: ${run.agent.name}. Its description: ${run.agent.description}`,
    `Test: ${run.testTitle}`,
    `Failed checks (computed deterministically from the records, treat as ground truth):\n${JSON.stringify(failures, null, 1)}`,
    `Report vs records:\n${g.reconciliation.map((r) => `${r.match ? "OK " : "MISMATCH "}${r.item}: claimed ${r.claimed}; actual ${r.actual}`).join("\n")}`,
    `Event log:\n${condensedLog(run)}`,
  ].join("\n\n");
  try {
    const out = await structured(
      ExplainSchema,
      "You explain why a finance agent failed a test, for a finance operations lead. Be concrete and brief. Base every statement on the event log and failed checks; do not speculate beyond them.",
      user,
    );
    if (!out) return templateExplanation(run);
    return { source: "ai", ...out };
  } catch (e) {
    const t = templateExplanation(run);
    return { ...t, explanation: `${t.explanation}\n\n(AI explanation unavailable: ${e instanceof Error ? e.message : String(e)})` };
  }
}
