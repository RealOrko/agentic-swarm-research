import fs from "node:fs";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { agentLoop } from "./agent-loop.js";
import { Context, ContextDB, createContext, setStore, getRootId } from "./context.js";
import { discoverModel } from "./llm.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { researchQuestionTool } from "./tools/research.js";
import { synthesizeFindingsTool } from "./tools/synthesize.js";
import { critiqueTool } from "./tools/critique.js";
import { submitReportTool, writeReport } from "./tools/submitReport.js";
import { getPoolStats, resetPoolStats } from "./worker-pool.js";
import { log, logRaw } from "./logger.js";
import type { ToolHandler } from "./agent-loop.js";

const DEFAULT_DB_PATH = path.resolve("data", "knowledge.db");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const orchestratorPrompt = fs.readFileSync(
  path.join(__dirname, "prompts/orchestrator.md"),
  "utf-8"
);

function buildPartialReport(ctx: Context): string {
  const goal = (ctx.store.goal as string) || "Unknown goal";
  const sections: string[] = [
    `# Partial Research Report (max iterations reached)`,
    ``,
    `**Goal:** ${goal}`,
    ``,
    `> This report was generated automatically because the orchestrator hit its iteration limit before calling submit_final_report.`,
    ``,
  ];

  // Extract findings from DB
  const findings = ctx.db.getNodesByType(ctx.sessionId, "finding");
  if (findings.length > 0) {
    sections.push(`## Research Findings`, ``);
    for (const f of findings) {
      const content = f.content || f.summary;
      const sources = (f.metadata.sources as string[]) || [];
      sections.push(`### Finding (via ${f.source})`, ``, content, ``);
      if (sources.length > 0) {
        sections.push(`**Sources:** ${sources.join(", ")}`, ``);
      }
      sections.push(`---`, ``);
    }
  }

  // Check for synthesis
  const syntheses = ctx.db.getNodesByType(ctx.sessionId, "synthesis")
    .filter((n) => n.content && n.content.length > 100);
  if (syntheses.length > 0) {
    const last = syntheses[syntheses.length - 1];
    sections.push(`## Synthesis`, ``, last.content!, ``);
  }

  return sections.join("\n");
}

export async function runResearch(
  goal: string,
  vectorKvKey?: string
): Promise<Context> {
  // Discover model capabilities before starting
  await discoverModel();

  // Open shared SQLite DB
  mkdirSync(path.resolve(DEFAULT_DB_PATH, ".."), { recursive: true });
  const db = new Database(DEFAULT_DB_PATH);
  db.pragma("journal_mode = WAL");

  // Create context backed by SQLite DB
  const contextDb = new ContextDB(db);
  const ctx = createContext(contextDb);

  // Initialize knowledge store (HTTP client to vector-kv)
  const kb = new KnowledgeStore(ctx.sessionId);
  ctx.knowledgeStore = kb;
  log("system", "Knowledge store initialized");

  setStore(ctx, "goal", goal, "system");
  if (vectorKvKey) {
    setStore(ctx, "vectorKey", vectorKvKey, "system");
  }

  const runStart = Date.now();
  resetPoolStats();

  const tools: ToolHandler[] = [
    researchQuestionTool,
    synthesizeFindingsTool,
    critiqueTool,
    submitReportTool,
  ];

  let promptAddendum = "";

  if (vectorKvKey) {
    promptAddendum = `\n\nA codebase has been indexed (key: "${vectorKvKey}"). Your research agents have access to \`search_code\` (semantic search) and \`grep_code\` (exact-match regex search) for investigating the code. Delegate ALL code investigation to \`research_question\` — you do not have direct access to search tools.`;
    log("system", `Starting research: "${goal}"`);
    log("system", `Vector-KV key: ${vectorKvKey}`);
  } else {
    log("system", `Starting research: "${goal}"`);
  }

  const { result, stats: orchestratorStats } = await agentLoop({
    name: "orchestrator",
    systemPrompt: orchestratorPrompt + promptAddendum,
    tools,
    userMessage: `Research goal: ${goal}`,
    ctx,
    maxIterations: 100,
  });

  // Print run summary
  const runDuration = Date.now() - runStart;
  const poolStats = getPoolStats();
  const totalPrompt = poolStats.totalPromptTokens + orchestratorStats.promptTokens;
  const totalCompletion = poolStats.totalCompletionTokens + orchestratorStats.completionTokens;
  const formatDur = (ms: number) => {
    const secs = Math.round(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  };
  const fmtTok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  logRaw("");
  logRaw(`  ── Summary ────────────────────────────────────────────`);
  logRaw(`  Duration:    ${formatDur(runDuration)}`);
  logRaw(`  Workers:     ${poolStats.spawned} spawned, ${poolStats.completed} completed, ${poolStats.failed} failed`);
  logRaw(`  Tokens:      ~${fmtTok(totalPrompt)} prompt, ~${fmtTok(totalCompletion)} completion`);
  logRaw(`  Orchestrator: ${orchestratorStats.iterations} iters, ~${fmtTok(orchestratorStats.promptTokens + orchestratorStats.completionTokens)} tokens`);
  logRaw(`  ──────────────────────────────────────────────────────`);
  logRaw("");

  // Check if submit_final_report was called
  const reportSubmitted = ctx.db.hasEvent(ctx.sessionId, "tool_call", "submit_final_report");

  if (!reportSubmitted) {
    log("system", "Orchestrator exited without submitting a report. Writing partial results...");
    const partialReport = buildPartialReport(ctx);
    const { reportPath } = writeReport(partialReport, ctx);
    log("system", `Partial report written to: ${reportPath}`);
  }

  return ctx;
}
