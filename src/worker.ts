/**
 * Worker entry point — runs in a child process.
 *
 * Protocol:
 *   stdin  ← single JSON line (WorkerInput)
 *   stdout → JSON lines: {"type":"log",...} or {"type":"result",...}
 *   stderr → forwarded as diagnostic logs
 *
 * Events and context nodes are written directly to the shared SQLite DB
 * (WAL mode allows concurrent writes from multiple workers).
 */

import { createInterface } from "node:readline";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { agentLoop } from "./agent-loop.js";
import type { ToolHandler } from "./agent-loop.js";
import { createContext, ContextDB } from "./context.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { discoverModel } from "./llm.js";
import { ToolRegistry } from "./tool-registry.js";
import { buildDefaultConfig } from "./config/index.js";
import type {
  WorkerInput,
  WorkerResultMessage,
  WorkerToolConfig,
} from "./worker-pool.js";
import type { Context } from "./context.js";

// ── Logging ────────────────────────────────────────────────────────────

function sendLog(message: string): void {
  const line = JSON.stringify({ type: "log", message, pid: process.pid });
  process.stdout.write(line + "\n");
}

function sendResult(result: WorkerResultMessage): void {
  const line = JSON.stringify(result);
  process.stdout.write(line + "\n");
}

// ── Tool resolution ────────────────────────────────────────────────────

async function resolveTools(
  configs: WorkerToolConfig[],
  ctx: Context,
  input: WorkerInput,
): Promise<ToolHandler[]> {
  const config = buildDefaultConfig();

  // If we have tool configs from a v2 config package, merge them in
  if (input.toolsConfig) {
    for (const [name, tc] of Object.entries(input.toolsConfig)) {
      config.tools[name] = tc;
    }
  }
  if (input.configPackageDir) {
    config.configPackageDir = input.configPackageDir;
  }

  const registry = new ToolRegistry();
  registry.registerBuiltins(config);

  // Load external tools from config package
  if (input.configPackageDir) {
    await registry.registerExternalsFromConfig(config);
  }

  const vectorKey = configs.find((c) => c.vectorKey)?.vectorKey;
  const toolNames = configs.map((c) => c.type);

  return registry.resolve(toolNames, config, { ctx, vectorKey });
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

  // Open shared SQLite DB (WAL mode — safe for concurrent access)
  const dbPath = resolve("data", "knowledge.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  // Create context backed by SQLite DB, using the parent's session ID
  const contextDb = new ContextDB(db);
  const ctx = createContext(contextDb, input.sessionId);

  // Knowledge store is an HTTP client to vector-kv — no local embeddings
  const kb = new KnowledgeStore(input.sessionId);
  ctx.knowledgeStore = kb;

  // Resolve tools
  const tools = await resolveTools(input.tools, ctx, input);

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

  // Send result — events and nodes are already in the shared SQLite DB
  const workerResult: WorkerResultMessage = {
    type: "result",
    result,
    stats,
  };

  sendResult(workerResult);
}

main().catch((err) => {
  // Worker uses stderr for fatal errors — parent process picks these up
  process.stderr.write(`Worker fatal error: ${err.message || err}\n`);
  process.exit(1);
});
