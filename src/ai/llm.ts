import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { z } from "zod";
import { anthropicAvailable, DEFAULT_CLAUDE_MODEL } from "../agent/anthropic.js";
import { openaiAvailable, DEFAULT_OPENAI_MODEL } from "../agent/openai.js";

/** Which model the lab itself uses for generation and explanations (not the agent under test). */
export function labModel(): { provider: "anthropic" | "openai"; model: string } | null {
  if (anthropicAvailable()) return { provider: "anthropic", model: process.env.LEDGERLAB_MODEL || DEFAULT_CLAUDE_MODEL };
  if (openaiAvailable()) return { provider: "openai", model: DEFAULT_OPENAI_MODEL };
  return null;
}

/** Ask the lab model for JSON matching `schema`. Returns null when no provider is configured. */
export async function structured<T extends z.ZodType>(schema: T, system: string, user: string): Promise<z.infer<T> | null> {
  const lm = labModel();
  if (!lm) return null;
  if (lm.provider === "anthropic") {
    const client = new Anthropic();
    const res = await client.messages.parse({
      model: lm.model,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: zodOutputFormat(schema), effort: "medium" },
    });
    if (res.stop_reason === "refusal") throw new Error("The lab model declined this request.");
    if (!res.parsed_output) throw new Error("The lab model returned output that did not match the schema.");
    return res.parsed_output as z.infer<T>;
  }
  const client = new OpenAI();
  const res = await client.chat.completions.create({
    model: lm.model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: `${system}\n\nRespond with a single JSON object matching this JSON Schema:\n${JSON.stringify(z.toJSONSchema(schema))}` },
      { role: "user", content: user },
    ],
  });
  return schema.parse(JSON.parse(res.choices[0]?.message?.content ?? "{}"));
}
