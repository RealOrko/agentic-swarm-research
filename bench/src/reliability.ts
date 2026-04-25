/**
 * reliability — run N replays at a given injected failure rate, report
 * completion_rate. Used to measure synthesis-strategy fault-tolerance.
 *
 * By default uses --mock-success so trials don't make real LLM calls; the
 * point is to measure strategy resilience to spawnWorker rejection, not
 * synthesis quality. Pass mockSuccess=false to exercise the real LLM path.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { replay } from "./replaySynthesis.js";

export interface ReliabilityArgs {
  fixture: string;
  config: string;
  rate: number;
  n: number;
  label: string;
  mockSuccess?: boolean;
}

export interface ReliabilityTrial {
  trial: number;
  success: boolean;
  wallMs?: number;
  outDir?: string;
  error?: string;
}

export interface ReliabilitySummary {
  fixture: string;
  config: string;
  label: string;
  rate: number;
  n: number;
  mockSuccess: boolean;
  successes: number;
  failures: number;
  completionRate: number;
  meanWallMs: number;
  trials: ReliabilityTrial[];
  runDir: string;
  startedAt: string;
  finishedAt: string;
}

export async function reliability(args: ReliabilityArgs): Promise<ReliabilitySummary> {
  const benchRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(benchRoot, "runs", `${ts}-reliability-${args.label}`);
  mkdirSync(runDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const trials: ReliabilityTrial[] = [];
  const mockSuccess = args.mockSuccess ?? true;

  for (let i = 0; i < args.n; i++) {
    const trialOut = path.join(runDir, `trials/${String(i).padStart(3, "0")}`);
    try {
      const r = await replay({
        fixture: args.fixture,
        config: args.config,
        outDir: trialOut,
        label: `${args.label}-trial-${i}`,
        injectFailureRate: args.rate,
        mockSuccess,
      });
      trials.push({ trial: i, success: true, wallMs: r.wallMs, outDir: r.outDir });
      process.stdout.write(`  trial ${i + 1}/${args.n}: ✓ (${(r.wallMs / 1000).toFixed(1)}s)\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      trials.push({ trial: i, success: false, error: msg });
      process.stdout.write(`  trial ${i + 1}/${args.n}: ✗ ${msg.slice(0, 80)}\n`);
    }
  }

  const successes = trials.filter((t) => t.success).length;
  const failures = args.n - successes;
  const completionRate = args.n > 0 ? successes / args.n : 0;
  const successWalls = trials.filter((t) => t.success && t.wallMs !== undefined).map((t) => t.wallMs!);
  const meanWallMs = successWalls.length ? successWalls.reduce((a, b) => a + b, 0) / successWalls.length : 0;

  const summary: ReliabilitySummary = {
    fixture: args.fixture,
    config: args.config,
    label: args.label,
    rate: args.rate,
    n: args.n,
    mockSuccess,
    successes,
    failures,
    completionRate,
    meanWallMs,
    trials,
    runDir,
    startedAt,
    finishedAt: new Date().toISOString(),
  };

  writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf-8");
  return summary;
}
