import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { TOOLS } from "../engine/tools.js";
import { systemPrompt, taskPrompt } from "../agent/types.js";
import { SCENARIO_MAP } from "../scenarios/library.js";
import type { Lab } from "../lab/lab.js";
import type { TestDef } from "../lab/types.js";

type ExternalRun = ReturnType<Lab["startExternalRun"]>;

/**
 * Bring your own agent: any MCP client connects to /mcp and gets the Bill Pay
 * tools of a fresh simulated world. Each MCP session is one live run that shows
 * in the dashboard, obeys its pause/chaos/clock controls, and is graded on submit_report.
 *
 *   /mcp?scenario=payment_timeout        a library scenario
 *   /mcp?test=test_ab12cd34              a saved test (with its extra exceptions and rules)
 *   &agent=My%20AP%20agent               the name shown in the dashboard
 */
export function createMcpHandler(lab: Lab) {
  const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; run: ExternalRun }>();

  const resolveTest = (url: URL): TestDef => {
    const testId = url.searchParams.get("test");
    const saved = testId ? lab.tests.find((t) => t.id === testId) : undefined;
    if (saved) return saved;
    const sc = SCENARIO_MAP.get(url.searchParams.get("scenario") ?? "happy_path") ?? SCENARIO_MAP.get("happy_path")!;
    return {
      id: `mcp_${sc.id}`, agentId: "external", title: sc.title, capability: sc.capability, scenarioId: sc.id, extraChaos: [],
      checks: sc.checks, rules: [], rationale: sc.summary, source: "library", createdAt: new Date().toISOString(),
    };
  };

  const jsonRpcError = (status: number, message: string) =>
    new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), { status, headers: { "content-type": "application/json" } });

  return async function handle(req: Request): Promise<Response> {
    const sid = req.headers.get("mcp-session-id");
    if (sid) {
      const s = sessions.get(sid);
      return s ? s.transport.handleRequest(req) : jsonRpcError(404, "Unknown or expired MCP session. Reconnect to start a new run.");
    }
    if (req.method !== "POST") return jsonRpcError(400, "Start a session with an MCP initialize request.");

    const url = new URL(req.url);
    let body: any;
    try {
      body = await req.clone().json();
    } catch {
      return jsonRpcError(400, "Invalid JSON.");
    }
    const init = Array.isArray(body) ? body.find((m) => m?.method === "initialize") : body?.method === "initialize" ? body : undefined;
    if (!init) return jsonRpcError(400, "The first request of a session must be initialize.");

    const clientName = String(init.params?.clientInfo?.name ?? "MCP agent").slice(0, 60);
    const agentName = (url.searchParams.get("agent") ?? clientName).slice(0, 60);
    const run = lab.startExternalRun({ test: resolveTest(url), agentName, agentModel: clientName });
    const world = run.harness.world;
    const instructions = [
      systemPrompt({ ...run.rec.agent, description: "Run accounts payable for Northwind Robotics using the Bill Pay tools." }, world.state),
      "",
      taskPrompt(run.task, world.state),
    ].join("\n");

    const server = new McpServer({ name: "ledger-lab", version: "0.1.0" }, { instructions });
    const live = () => run.rec.status === "running" || run.rec.status === "paused";

    server.registerTool("get_task", { description: "Read your task, company policy, and the current simulated time. Call this first." }, async () => ({
      content: [{ type: "text" as const, text: instructions }],
    }));

    for (const tool of TOOLS) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async (args: unknown) => {
        if (!live()) return { content: [{ type: "text" as const, text: "This run has ended. Reconnect to start a new one." }], isError: true };
        await run.harness.gate();
        if (run.harness.control.stopped) {
          run.finish("stopped");
          return { content: [{ type: "text" as const, text: "The operator stopped this run." }], isError: true };
        }
        run.countStep();
        const out = run.harness.callTool(tool.name, args);
        if (out.terminal) run.finish("report");
        return { content: [{ type: "text" as const, text: out.output }], isError: out.isError };
      });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, run });
      },
      onsessionclosed: (id) => {
        sessions.get(id)?.run.finish("no_action");
        sessions.delete(id);
      },
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
