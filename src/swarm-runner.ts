import path from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import type OpenAI from "openai";
import { agentLoop } from "./agent-loop.js";
import type { ToolHandler } from "./agent-loop.js";
import { Context, ContextDB, createContext, setStore } from "./context.js";
import { createLLMClient, discoverModelFor } from "./llm.js";
import type { ModelInfo } from "./llm.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { AgentFactory } from "./agent-factory.js";
import { createResearchQuestionTool } from "./tools/research.js";
import { createSynthesizeTool } from "./tools/synthesize.js";
import { createCritiqueTool } from "./tools/critique.js";
import { submitReportTool, writeReport } from "./tools/submitReport.js";
import { createSynthesisStrategy } from "./synthesis/strategies.js";
import { orchestratorNudgeStrategy } from "./nudge/orchestrator-nudge.js";
import { getPoolStats, resetPoolStats } from "./worker-pool.js";
import { log, logRaw } from "./logger.js";
import { buildDefaultConfig, loadConfigFromFile, validateConfig } from "./config/index.js";
import type { SwarmConfig } from "./config/types.js";
import type { PoolStats } from "./worker-pool.js";
import type { AgentStats } from "./agent-loop.js";

export interface RunResult {
  ctx: Context;
  reportPath: string | null;
  stats: {
    duration: number;
    poolStats: PoolStats;
    orchestratorStats: AgentStats;
  };
}

export class SwarmRunner {
  private config: SwarmConfig;
  private llmClient: OpenAI;
  private modelInfo: ModelInfo | null = null;

  private constructor(config: SwarmConfig) {
    this.config = config;
    this.llmClient = createLLMClient(config.global.baseUrl, config.global.apiKey);
  }

  /** Load config from a YAML file, validate, and prepare the runner */
  static async fromFile(configPath: string): Promise<SwarmRunner> {
    const config = await loadConfigFromFile(configPath);
    const runner = new SwarmRunner(config);
    runner.validateOrThrow();
    return runner;
  }

  /** Create a runner from a config object (for programmatic use or defaults) */
  static async fromConfig(config: SwarmConfig): Promise<SwarmRunner> {
    const runner = new SwarmRunner(config);
    // Skip validation for default config (it's known-good)
    return runner;
  }

  /** Validate config and throw on errors */
  private validateOrThrow(): void {
    const result = validateConfig(this.config);
    if (!result.ok) {
      const errorMessages = result.errors.map((e) => `  [${e.path}] ${e.message}`).join("\n");
      throw new Error(`Invalid swarm configuration:\n${errorMessages}`);
    }
    for (const warning of result.warnings) {
      log("config", `Warning: [${warning.path}] ${warning.message}`);
    }
  }

  /** Discover model capabilities */
  private async discover(): Promise<void> {
    if (!this.modelInfo) {
      this.modelInfo = await discoverModelFor(
        this.llmClient,
        this.config.global.model,
        this.config.global.charsPerToken,
      );
    }
  }

  /** Run the swarm with the given goal */
  async run(goal: string, runtimeVars?: Record<string, string>): Promise<RunResult> {
    // Discover model
    await this.discover();

    const config = this.config;
    const vectorKey = runtimeVars?.vectorKey;
    const dbPath = path.resolve(config.global.dbPath);

    // Open shared SQLite DB
    mkdirSync(path.resolve(dbPath, ".."), { recursive: true });
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");

    // Create context
    const contextDb = new ContextDB(db);
    const ctx = createContext(contextDb);

    // Initialize knowledge store
    const kb = new KnowledgeStore(ctx.sessionId);
    ctx.knowledgeStore = kb;
    log("system", "Knowledge store initialized");

    setStore(ctx, "goal", goal, "system");
    if (vectorKey) {
      setStore(ctx, "vectorKey", vectorKey, "system");
    }

    const runStart = Date.now();
    resetPoolStats();

    // Create AgentFactory and wire meta-tools
    const agentFactory = new AgentFactory(config);
    const synthesisStrategy = createSynthesisStrategy(config.synthesis);

    const tools: ToolHandler[] = [
      createResearchQuestionTool(agentFactory),
      createSynthesizeTool(synthesisStrategy, agentFactory),
      createCritiqueTool(agentFactory),
      submitReportTool,
    ];

    // Build orchestrator prompt
    const entrypointName = config.topology.entrypoint;
    const entrypointDef = config.agents[entrypointName];
    const prompt = agentFactory.readPrompt(entrypointDef);

    let promptAddendum = "";
    if (vectorKey) {
      promptAddendum = `\n\nA codebase has been indexed (key: "${vectorKey}"). Your research agents have access to \`search_code\` (semantic search) and \`grep_code\` (exact-match regex search) for investigating the code. Delegate ALL code investigation to \`research_question\` — you do not have direct access to search tools.`;
      log("system", `Starting research: "${goal}"`);
      log("system", `Vector-KV key: ${vectorKey}`);
    } else {
      log("system", `Starting research: "${goal}"`);
    }

    // Run the entrypoint agent loop
    const { result, stats: orchestratorStats } = await agentLoop({
      name: entrypointName,
      systemPrompt: prompt + promptAddendum,
      tools,
      userMessage: `Research goal: ${goal}`,
      ctx,
      maxIterations: entrypointDef.limits.maxIterations,
      toolCallBudget: entrypointDef.limits.toolCallBudget,
      maxNudges: entrypointDef.limits.maxNudges,
      nudgeStrategy: orchestratorNudgeStrategy,
      temperature: entrypointDef.temperature ?? config.global.temperature,
      toolBatchSize: config.global.limits.toolBatchSize,
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

    // Check if terminal tool was called
    const terminalTool = config.topology.terminal.tool;
    const reportSubmitted = ctx.db.hasEvent(ctx.sessionId, "tool_call", terminalTool);
    let reportPath: string | null = null;

    if (!reportSubmitted) {
      log("system", "Orchestrator exited without submitting a report. Writing partial results...");
      const partialReport = buildPartialReport(ctx);
      const { reportPath: rp } = writeReport(partialReport, ctx);
      reportPath = rp;
      log("system", `Partial report written to: ${rp}`);
    }

    return {
      ctx,
      reportPath,
      stats: {
        duration: runDuration,
        poolStats,
        orchestratorStats,
      },
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

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

  const syntheses = ctx.db.getNodesByType(ctx.sessionId, "synthesis")
    .filter((n) => n.content && n.content.length > 100);
  if (syntheses.length > 0) {
    const last = syntheses[syntheses.length - 1];
    sections.push(`## Synthesis`, ``, last.content!, ``);
  }

  return sections.join("\n");
}
