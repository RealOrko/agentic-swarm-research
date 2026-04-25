/**
 * replaySynthesis — load a fixture + a synthesis config, run the real
 * SynthesisStrategy, write report.md + trace.json.
 *
 * Bypasses the orchestrator and research phase. Uses the production
 * AgentFactory + SynthesisStrategy code paths so we're testing the real
 * thing, not a fork.
 *
 * Usage:
 *   tsx bench/src/replaySynthesis.ts --fixture <name> --config <dir-or-yaml> [--label <name>] [--out <dir>]
 *
 * Each run is isolated to its own DB under bench/runs/<ts>-<label>/replay.db.
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
// Side effect: loads .env for BASE_URL / MODEL_NAME / etc.
import "../../src/llm.js";
import { loadConfigFromFile } from "../../src/config/loader.js";
import { ContextDB, createContext, setStore } from "../../src/context.js";
import { AgentFactory } from "../../src/agent-factory.js";
import { createSynthesisStrategy } from "../../src/synthesis/strategies.js";
import { configureWorkerPool, resetPoolStats, getPoolStats } from "../../src/worker-pool.js";
import { closeLogger } from "../../src/logger.js";

interface FixtureFinding {
  question: string;
  answer: string;
  sources: string[];
  origNodeId: string;
}

interface FixtureFile {
  goal: string;
  findings: FixtureFinding[];
}

export interface ReplayArgs {
  fixture: string;
  config: string;
  outDir?: string;
  label?: string;
  /**
   * Probability (0..1) that each spawnWorker call throws a synthetic error.
   * Used to measure strategy fault-tolerance.
   */
  injectFailureRate?: number;
  /**
   * If true, successful spawnWorker calls return a stub result instead of
   * spawning a real LLM worker. Used together with injectFailureRate to run
   * cheap, in-process reliability trials.
   */
  mockSuccess?: boolean;
}

export interface ReplayResult {
  outDir: string;
  reportPath: string;
  tracePath: string;
  runInfoPath: string;
  wallMs: number;
}

export async function replay(args: ReplayArgs): Promise<ReplayResult> {
  const benchRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const projectRoot = path.resolve(benchRoot, "..");

  // Load fixture
  const fixtureDir = path.resolve(benchRoot, "fixtures", args.fixture);
  const fixturePath = path.join(fixtureDir, "findings.json");
  const fixture: FixtureFile = JSON.parse(readFileSync(fixturePath, "utf-8"));

  // Resolve config — pass through to the real loader; it handles file or directory
  const configAbs = path.resolve(args.config);

  // Output dir
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const label = args.label ?? path.basename(configAbs).replace(/\.ya?ml$/, "");
  const outDir = args.outDir ?? path.join(benchRoot, "runs", `${ts}-${label}`);
  mkdirSync(outDir, { recursive: true });

  // Load config and override DB path so each run is isolated
  const config = await loadConfigFromFile(configAbs);
  const dbPath = path.join(outDir, "replay.db");
  config.global.dbPath = dbPath;

  // Open isolated DB
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  let wallMs = 0;
  let finalReport = "";
  let sessionId = "";
  let synthNodeRows: ReturnType<ContextDB["getNodesByType"]> = [];
  let poolStats: ReturnType<typeof getPoolStats>;

  try {
    const contextDb = new ContextDB(db);
    const ctx = createContext(contextDb);
    sessionId = ctx.sessionId;
    setStore(ctx, "goal", fixture.goal, "system");

    // Worker pool config matches production
    resetPoolStats();
    configureWorkerPool({
      maxWorkers: config.global.limits.maxWorkers,
      workerTimeoutMs: config.global.limits.workerTimeoutMs,
    });

    const agentFactory = new AgentFactory(config);

    // Test injection: wrap spawnWorker for reliability trials. Both flags are
    // additive — failure injection happens first, then success either spawns
    // a real worker or returns a mock.
    if (args.injectFailureRate || args.mockSuccess) {
      const orig = agentFactory.spawnWorker.bind(agentFactory);
      const failRate = args.injectFailureRate ?? 0;
      const useMock = args.mockSuccess ?? false;
      agentFactory.spawnWorker = (async (
        agentName: string,
        userMessage: string,
        c: typeof ctx,
        overrides?: Parameters<typeof orig>[3],
      ) => {
        if (failRate > 0 && Math.random() < failRate) {
          throw new Error(`[injected failure rate=${failRate}]`);
        }
        if (useMock) {
          const label = overrides?.name ?? agentName;
          return {
            type: "result" as const,
            result: `[MOCK ${label}] synthesis stub for prompt of length ${userMessage.length}`,
            stats: { iterations: 1, promptTokens: 0, completionTokens: 0 },
          };
        }
        return orig(agentName, userMessage, c, overrides);
      }) as typeof agentFactory.spawnWorker;
    }

    const strategy = createSynthesisStrategy(config.synthesis);

    const start = Date.now();
    finalReport = await strategy.synthesize(
      fixture.goal,
      // FixtureFinding shape == Finding interface (question/answer/sources)
      fixture.findings.map((f) => ({
        question: f.question,
        answer: f.answer,
        sources: f.sources,
      })),
      ctx,
      agentFactory,
    );
    wallMs = Date.now() - start;
    poolStats = getPoolStats();

    synthNodeRows = contextDb.getNodesByType(ctx.sessionId, "synthesis");
  } finally {
    db.close();
    await closeLogger();
  }

  // Build trace.json — synthesis nodes + fixture context for downstream metrics
  const trace = {
    sessionId,
    fixture: args.fixture,
    fixturePath: path.relative(projectRoot, fixturePath),
    config: path.relative(projectRoot, configAbs),
    label,
    wallMs,
    poolStats: poolStats!,
    fixtureFindings: fixture.findings.map((f, i) => ({
      idx: i,
      question: f.question,
      answerLength: f.answer.length,
      tokenEstimate: Math.ceil(f.answer.length / 3),
      sourcesCount: f.sources.length,
    })),
    rounds: synthNodeRows.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      source: n.source,
      summary: n.summary,
      content: n.content,
      tokenEstimate: n.tokenEstimate,
      timestamp: n.timestamp,
      metadata: n.metadata,
    })),
  };

  const reportPath = path.join(outDir, "report.md");
  const tracePath = path.join(outDir, "trace.json");
  const runInfoPath = path.join(outDir, "run.json");

  writeFileSync(reportPath, finalReport, "utf-8");
  writeFileSync(tracePath, JSON.stringify(trace, null, 2), "utf-8");
  writeFileSync(
    runInfoPath,
    JSON.stringify(
      {
        fixture: args.fixture,
        config: path.relative(projectRoot, configAbs),
        label,
        sessionId,
        wallMs,
        poolStats: poolStats!,
        finalReportLength: finalReport.length,
        finalReportTokens: Math.ceil(finalReport.length / 3),
        synthNodesCount: synthNodeRows.length,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );

  return { outDir, reportPath, tracePath, runInfoPath, wallMs };
}

function parseArgs(): ReplayArgs {
  const argv = process.argv.slice(2);
  const out: Partial<ReplayArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture" && i + 1 < argv.length) out.fixture = argv[++i];
    else if (a === "--config" && i + 1 < argv.length) out.config = argv[++i];
    else if (a === "--out" && i + 1 < argv.length) out.outDir = argv[++i];
    else if (a === "--label" && i + 1 < argv.length) out.label = argv[++i];
    else if (a === "--inject-failure-rate" && i + 1 < argv.length) out.injectFailureRate = parseFloat(argv[++i]);
    else if (a === "--mock-success") out.mockSuccess = true;
    else {
      console.error(`Unknown or incomplete arg: ${a}`);
      process.exit(2);
    }
  }
  if (!out.fixture || !out.config) {
    console.error(
      "Usage: tsx bench/src/replaySynthesis.ts --fixture <name> --config <dir-or-yaml> [--label <name>] [--out <dir>] [--inject-failure-rate <0..1>] [--mock-success]",
    );
    process.exit(2);
  }
  return out as ReplayArgs;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const start = Date.now();
  const result = await replay(args);
  const totalMs = Date.now() - start;

  console.log(`Wrote ${result.outDir}`);
  console.log(`  synthesis: ${(result.wallMs / 1000).toFixed(1)}s`);
  console.log(`  total:     ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  report:    ${result.reportPath}`);
  console.log(`  trace:     ${result.tracePath}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
