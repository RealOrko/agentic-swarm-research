/**
 * Worker entry point — runs in a child process.
 *
 * Protocol:
 *   stdin  ← single JSON line (WorkerInput)
 *   stdout → JSON lines: {"type":"log",...} or {"type":"result",...}
 *   stderr → forwarded as diagnostic logs
 */

import { createInterface } from "node:readline";
import { agentLoop } from "./agent-loop.js";
import type { ToolHandler } from "./agent-loop.js";
import { createContext, type Context, type ContextNode } from "./context.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { discoverModel } from "./llm.js";
import { webSearchTool } from "./tools/webSearch.js";
import { fetchPageTool } from "./tools/fetchPage.js";
import { createQueryKnowledgeTool } from "./tools/queryKnowledge.js";
import {
  createListFilesTool,
  createReadFileTool,
  createGrepCodeTool,
} from "./tools/codeTools.js";
import type {
  WorkerInput,
  WorkerResultMessage,
  WorkerToolConfig,
  SerializedNode,
} from "./worker-pool.js";
// ── Logging ────────────────────────────────────────────────────────────

function sendLog(message: string): void {
  const line = JSON.stringify({ type: "log", message });
  process.stdout.write(line + "\n");
}

function sendResult(result: WorkerResultMessage): void {
  const line = JSON.stringify(result);
  process.stdout.write(line + "\n");
}

// ── Tool resolution ────────────────────────────────────────────────────

function resolveTools(
  configs: WorkerToolConfig[],
  ctx: Context
): ToolHandler[] {
  const handlers: ToolHandler[] = [];

  for (const cfg of configs) {
    switch (cfg.type) {
      case "web_search":
        handlers.push(webSearchTool);
        break;
      case "fetch_page":
        handlers.push(fetchPageTool);
        break;
      case "query_knowledge":
        handlers.push(createQueryKnowledgeTool());
        break;
      case "list_files":
        if (cfg.repoPath) handlers.push(createListFilesTool(cfg.repoPath));
        break;
      case "read_file":
        if (cfg.repoPath) handlers.push(createReadFileTool(cfg.repoPath));
        break;
      case "grep_code":
        if (cfg.repoPath) handlers.push(createGrepCodeTool(cfg.repoPath));
        break;
      case "submit_finding":
        handlers.push({
          definition: {
            type: "function",
            function: {
              name: "submit_finding",
              description:
                "Submit your research finding. Call this once you have gathered enough information.",
              parameters: {
                type: "object",
                properties: {
                  answer: {
                    type: "string",
                    description: "Your detailed answer",
                  },
                  sources: {
                    type: "array",
                    items: { type: "string" },
                    description: "List of sources used",
                  },
                },
                required: ["answer", "sources"],
              },
            },
          },
          terminates: true,
          handler: async (args: Record<string, unknown>) => {
            return { answer: args.answer, sources: args.sources };
          },
        });
        break;
      case "submit_critique":
        handlers.push({
          definition: {
            type: "function",
            function: {
              name: "submit_critique",
              description:
                "Submit your critique of the synthesis.",
              parameters: {
                type: "object",
                properties: {
                  approved: {
                    type: "boolean",
                    description: "Whether the synthesis is adequate",
                  },
                  feedback: {
                    type: "string",
                    description: "Detailed feedback",
                  },
                  gaps: {
                    type: "array",
                    items: { type: "string" },
                    description: "Specific gaps needing further research",
                  },
                },
                required: ["approved", "feedback", "gaps"],
              },
            },
          },
          terminates: true,
          handler: async (args: Record<string, unknown>) => {
            return {
              approved: args.approved,
              feedback: args.feedback,
              gaps: args.gaps,
            };
          },
        });
        break;
      default:
        sendLog(`Unknown tool type: ${cfg.type}`);
    }
  }

  return handlers;
}

// ── Serialization ──────────────────────────────────────────────────────

function serializeNodes(ctx: Context): SerializedNode[] {
  const nodes: SerializedNode[] = [];
  for (const [, node] of ctx.tree.nodes) {
    nodes.push({ ...node });
  }
  return nodes;
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Read single JSON line from stdin
  const rl = createInterface({ input: process.stdin });
  const firstLine = await new Promise<string>((resolve, reject) => {
    rl.once("line", resolve);
    rl.once("close", () => reject(new Error("stdin closed without input")));
  });
  rl.close();

  const input: WorkerInput = JSON.parse(firstLine);

  // Discover model capabilities (silent — orchestrator logs this once)
  await discoverModel(true);

  // Create isolated context
  const ctx = createContext();

  // Connect to shared knowledge store (SQLite with WAL mode — safe for concurrent access)
  const kb = await KnowledgeStore.create();
  ctx.knowledgeStore = kb;

  // Resolve tools
  const tools = resolveTools(input.tools, ctx);

  // Custom logFn that routes through JSON protocol to parent
  const workerLogFn = (_agent: string, message: string): void => {
    sendLog(message);
  };

  // Run agent loop
  const { result, stats } = await agentLoop({
    name: input.name,
    systemPrompt: input.systemPrompt,
    tools,
    userMessage: input.userMessage,
    ctx,
    maxIterations: input.maxIterations,
    tokenBudget: input.tokenBudget,
    allowTextResponse: input.allowTextResponse,
    logFn: workerLogFn,
  });

  // Send result
  const workerResult: WorkerResultMessage = {
    type: "result",
    result,
    stats,
    rootId: ctx.tree.rootId,
    events: ctx.events,
    nodes: serializeNodes(ctx),
  };

  sendResult(workerResult);
}

main().catch((err) => {
  console.error(`Worker fatal error: ${err.message || err}`);
  process.exit(1);
});
