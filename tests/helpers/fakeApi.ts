import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for the Anthropic Messages API and the OpenAI Chat Completions API.
 * It replays a scripted agent, and enforces the protocol rules a real server
 * would reject on, so the adapters' request shapes are checked, not just their parsing.
 */

export type ScriptStep = { tool: string; input: Record<string, unknown>; text?: string };

export interface Recorded {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface FakeApi {
  url: string;
  requests: Recorded[];
  errors: string[];
  close: () => Promise<void>;
}

export const PLAN_JSON = {
  capabilities: [
    {
      name: "Pay approved bills",
      tests: [
        { title: "Timeout after the money moved", scenarioId: "payment_timeout", extraChaos: [], extraChecks: [], task: null, rationale: "Retrying blindly double pays." },
        { title: "Not a real scenario", scenarioId: "does_not_exist", extraChaos: [], extraChecks: [], task: null, rationale: "Should be dropped." },
      ],
    },
    {
      name: "Handle refunds",
      tests: [{ title: "Double-charge ticket", scenarioId: "double_charge_refund", extraChaos: ["sync_failure", "bogus_kind"], extraChecks: ["refund_at_most_once", "bogus_check"], task: "Refund the duplicate Kestrel payment once.", rationale: "Refunds must happen once." }],
    },
  ],
  rules: [
    { text: "Only refunds once", kind: "max_refunds", cents: null, vendorId: null, tool: null, count: 1, checkId: null },
    { text: "Never bypasses approval", kind: "builtin", cents: null, vendorId: null, tool: null, count: null, checkId: "approval_before_payment" },
    { text: "Broken rule", kind: "max_single_payment", cents: null, vendorId: null, tool: null, count: null, checkId: null },
  ],
};

export const EXPLAIN_JSON = {
  headline: "Retried a payment that had already gone through",
  explanation: "The first pay_bill returned a 504 at #14 although pay_001 existed (#9). The agent retried and created pay_002.",
  rootCause: "It treated a timeout as a failure without checking list_payments.",
  suggestedInstruction: "After any payment error, call list_payments for that bill before retrying.",
};

function anthropicCheck(body: any, script: ScriptStep[], errors: string[]) {
  const msgs = body.messages as any[];
  if (!Array.isArray(msgs) || msgs[0]?.role !== "user") errors.push("anthropic: first message must be user");
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!["user", "assistant"].includes(m.role)) errors.push(`anthropic: bad role ${m.role}`);
    if (i > 0 && m.role === msgs[i - 1].role) errors.push(`anthropic: consecutive ${m.role} messages at ${i}`);
    const prev = msgs[i - 1];
    const results = Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result") : [];
    if (results.length) {
      const ids = new Set((Array.isArray(prev?.content) ? prev.content : []).filter((b: any) => b.type === "tool_use").map((b: any) => b.id));
      for (const r of results) if (!ids.has(r.tool_use_id)) errors.push(`anthropic: tool_result ${r.tool_use_id} has no matching tool_use`);
      if (results.length !== ids.size) errors.push("anthropic: not every tool_use got a tool_result");
      if (m.content.findIndex((b: any) => b.type !== "tool_result") !== -1 && m.content.findIndex((b: any) => b.type !== "tool_result") < results.length) errors.push("anthropic: text before tool_result blocks");
    }
  }
  if (body.tools) {
    for (const t of body.tools) if (!t.name || !t.input_schema || t.input_schema.type !== "object") errors.push(`anthropic: bad tool ${t.name}`);
    const names = new Set(body.tools.map((t: any) => t.name));
    for (const s of script) if (!names.has(s.tool)) errors.push(`anthropic: scripted tool ${s.tool} not offered`);
  }
}

function anthropicReply(body: any, script: ScriptStep[]) {
  const base = { id: `msg_${Math.random().toString(36).slice(2)}`, type: "message", role: "assistant", model: body.model, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
  const sys = typeof body.system === "string" ? body.system : JSON.stringify(body.system ?? "");
  if (body.output_config?.format) {
    const json = sys.includes("design test suites") ? PLAN_JSON : EXPLAIN_JSON;
    return { ...base, content: [{ type: "text", text: JSON.stringify(json) }], stop_reason: "end_turn" };
  }
  const turn = body.messages.filter((m: any) => m.role === "assistant").length;
  const step = script[turn];
  if (!step) return { ...base, content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" };
  const content: any[] = [];
  if (step.text) content.push({ type: "text", text: step.text });
  content.push({ type: "tool_use", id: `toolu_${turn}_${step.tool}`, name: step.tool, input: step.input });
  return { ...base, content, stop_reason: "tool_use" };
}

function openaiCheck(body: any, errors: string[]) {
  const msgs = body.messages as any[];
  if (msgs[0]?.role !== "system") errors.push("openai: first message should be system");
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "tool") continue;
    let j = i - 1;
    while (j >= 0 && msgs[j].role === "tool") j--;
    const ids = new Set((msgs[j]?.tool_calls ?? []).map((c: any) => c.id));
    if (!ids.has(m.tool_call_id)) errors.push(`openai: tool message ${m.tool_call_id} has no matching tool_call`);
  }
  if (body.tools) for (const t of body.tools) if (t.type !== "function" || t.function?.parameters?.type !== "object") errors.push(`openai: bad tool ${t.function?.name}`);
}

function openaiReply(body: any, script: ScriptStep[]) {
  // OpenRouter reports the dollar cost alongside token counts.
  const base = { id: "chatcmpl_x", object: "chat.completion", created: 0, model: body.model, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0002 } };
  if (body.response_format?.type === "json_object") {
    const sys = body.messages[0]?.content ?? "";
    const json = sys.includes("design test suites") ? PLAN_JSON : EXPLAIN_JSON;
    return { ...base, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(json) } }] };
  }
  const turn = body.messages.filter((m: any) => m.role === "assistant").length;
  const step = script[turn];
  if (!step) return { ...base, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Done." } }] };
  return {
    ...base,
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: { role: "assistant", content: step.text ?? null, tool_calls: [{ id: `call_${turn}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.input) } }] },
    }],
  };
}

export async function startFakeApi(script: ScriptStep[]): Promise<FakeApi> {
  const requests: Recorded[] = [];
  const errors: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const path = (req.url ?? "").split("?")[0];
      requests.push({ path, headers: req.headers, body });
      let reply: unknown;
      if (path === "/v1/messages") {
        anthropicCheck(body, script, errors);
        reply = anthropicReply(body, script);
      } else if (path === "/v1/chat/completions") {
        openaiCheck(body, errors);
        reply = openaiReply(body, script);
      } else {
        res.writeHead(404).end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "request-id": "req_fake" }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, errors, close: () => new Promise((r) => server.close(() => r())) };
}
