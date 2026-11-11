import Anthropic from "@anthropic-ai/sdk";
import { toolJsonSchemas } from "../engine/tools.js";
import { priceUsage, type AgentSession, type AgentTurn, type ToolResult } from "./types.js";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

let client: Anthropic | undefined;
const getClient = () => (client ??= new Anthropic());

export function anthropicAvailable(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/**
 * Agent under test, driven by Claude through a manual tool loop so the lab can
 * interleave chaos and clock changes between turns.
 * Server-side refusal fallback is enabled ("default" routing).
 */
export function anthropicSession(opts: { model: string; system: string; task: string; effort?: "low" | "medium" | "high" }): AgentSession {
  const tools: Anthropic.Beta.BetaTool[] = toolJsonSchemas().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema,
  }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  let first = true;

  return {
    async next(results: ToolResult[], notices: string[]): Promise<AgentTurn> {
      if (first) {
        messages.push({ role: "user", content: [opts.task, ...notices].join("\n\n") });
        first = false;
      } else {
        const content: Anthropic.Beta.BetaContentBlockParam[] = results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: r.output,
          is_error: r.isError,
        }));
        if (notices.length) content.push({ type: "text", text: notices.join("\n") });
        messages.push({ role: "user", content });
      }

      const response = await getClient().beta.messages.create({
        model: opts.model || DEFAULT_CLAUDE_MODEL,
        max_tokens: 16000,
        system: opts.system,
        tools,
        messages,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
      });

      // Append the full content so thinking blocks stay attached to their turn.
      messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      const calls = response.content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));

      const usage = priceUsage(response.model ?? opts.model, response.usage?.input_tokens ?? 0, response.usage?.output_tokens ?? 0);
      if (response.stop_reason === "refusal") return { text, calls: [], stopReason: "refusal", usage };
      if (response.stop_reason === "max_tokens") return { text, calls: [], stopReason: "max_tokens", usage };
      return { text: text || undefined, calls, usage };
    },
  };
}
