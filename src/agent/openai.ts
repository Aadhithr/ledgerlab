import OpenAI from "openai";
import { toolJsonSchemas } from "../engine/tools.js";
import { priceUsage, type AgentSession, type AgentTurn, type ToolResult } from "./types.js";

export const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";

let client: OpenAI | undefined;
const getClient = () => (client ??= new OpenAI());

export function openaiAvailable(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/** Agent under test, driven by an OpenAI chat model with function calling. */
export function openaiSession(opts: { model: string; system: string; task: string }): AgentSession {
  const tools = toolJsonSchemas().map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: opts.system }];
  let first = true;

  return {
    async next(results: ToolResult[], notices: string[]): Promise<AgentTurn> {
      if (first) {
        messages.push({ role: "user", content: [opts.task, ...notices].join("\n\n") });
        first = false;
      } else {
        for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `ERROR: ${r.output}` : r.output });
        if (notices.length) messages.push({ role: "user", content: notices.join("\n") });
      }
      const res = await getClient().chat.completions.create({ model: opts.model || DEFAULT_OPENAI_MODEL, messages, tools });
      const msg = res.choices[0]?.message;
      // OpenRouter adds the dollar cost to usage; plain OpenAI does not.
      const u = res.usage as (typeof res.usage & { cost?: number }) | undefined;
      const usage = priceUsage(opts.model || DEFAULT_OPENAI_MODEL, u?.prompt_tokens ?? 0, u?.completion_tokens ?? 0, u?.cost);
      if (!msg) return { calls: [], stopReason: "empty", usage };
      messages.push(msg as OpenAI.Chat.ChatCompletionMessageParam);
      const calls = (msg.tool_calls ?? [])
        .filter((c) => c.type === "function")
        .map((c) => {
          let input: unknown = {};
          try {
            input = JSON.parse(c.function.arguments || "{}");
          } catch {
            input = { __unparseable: c.function.arguments };
          }
          return { id: c.id, name: c.function.name, input };
        });
      return { text: msg.content?.trim() || undefined, calls, usage };
    },
  };
}
