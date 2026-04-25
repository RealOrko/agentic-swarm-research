#!/usr/bin/env -S npx tsx
/**
 * bench — unified CLI for the synthesis-replay harness.
 *
 * Subcommands:
 *   bench extract <context.json> <fixture-name>
 *   bench replay  --fixture <name> --config <dir-or-yaml> [--label <name>] [--out <dir>]
 *   bench metrics <run-dir>
 *   bench diff    <run-dir> <baseline-dir>
 *   bench measure --fixture <name> --config <dir-or-yaml> [--label <name>] [--baseline <dir>]
 *       (replay → metrics → diff in one shot)
 */

import path from "node:path";
import { extractFixture } from "./extractFixture.js";
import { replay } from "./replaySynthesis.js";
import { computeMetrics } from "./computeMetrics.js";
import { diff } from "./diffMetrics.js";
import { reliability } from "./reliability.js";
import { writeFileSync, mkdirSync, copyFileSync } from "node:fs";

const HELP = `bench — synthesis-replay benchmarking harness

Subcommands:
  extract <context.json> <fixture-name>
      Extract a replayable fixture from a real run's context.json.

  replay  --fixture <name> --config <dir-or-yaml> [--label <name>] [--out <dir>]
      Run synthesis on a fixture using the real SynthesisStrategy.

  metrics <run-dir>
      Compute metrics.json for a completed run.

  diff <run-dir> <baseline-dir>
      Compare a run's metrics against a baseline; writes <run-dir>/diff.md.

  measure --fixture <name> --config <dir-or-yaml> [--label <name>] [--baseline <dir>]
      replay → metrics → diff in one shot.

  reliability --fixture <name> --config <dir-or-yaml> --rate <0..1> [--n 20] [--label <name>]
      Run N trials with injected failures (mock-success by default — no LLM calls).
      Emits summary.json with completion_rate.

Examples:
  bench extract path/to/context.json my-fixture
  bench replay --fixture skynet-genesis --config bench/configs/baseline --label baseline
  bench metrics bench/runs/2026-04-24T...
  bench diff bench/runs/<latest> bench/baseline/skynet-genesis
`;

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = "true";
    }
  }
  return out;
}

async function cmdExtract(args: string[]): Promise<void> {
  const [contextPath, name] = args;
  if (!contextPath || !name) {
    console.error("Usage: bench extract <context.json> <fixture-name>");
    process.exit(2);
  }
  const fixture = extractFixture(contextPath);
  const benchRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const outDir = path.join(benchRoot, "fixtures", name);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "goal.txt"), fixture.goal + "\n", "utf-8");
  writeFileSync(
    path.join(outDir, "findings.json"),
    JSON.stringify(
      {
        goal: fixture.goal,
        origContextPath: fixture.origContextPath,
        extractedAt: fixture.extractedAt,
        findings: fixture.findings,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  copyFileSync(contextPath, path.join(outDir, "source-context.json"));
  console.log(`Extracted "${name}": ${fixture.findings.length} findings → ${outDir}`);
}

async function cmdReplay(args: string[]): Promise<string> {
  const flags = parseFlags(args);
  if (!flags.fixture || !flags.config) {
    console.error("Usage: bench replay --fixture <name> --config <dir-or-yaml> [--label <name>] [--out <dir>]");
    process.exit(2);
  }
  const result = await replay({
    fixture: flags.fixture,
    config: flags.config,
    label: flags.label,
    outDir: flags.out,
  });
  console.log(`Replay → ${result.outDir} (${(result.wallMs / 1000).toFixed(1)}s)`);
  return result.outDir;
}

async function cmdMetrics(args: string[]): Promise<void> {
  const [runDir] = args;
  if (!runDir) {
    console.error("Usage: bench metrics <run-dir>");
    process.exit(2);
  }
  const benchRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const projectRoot = path.resolve(benchRoot, "..");
  const m = computeMetrics(path.resolve(runDir), projectRoot);
  const outPath = path.join(path.resolve(runDir), "metrics.json");
  writeFileSync(outPath, JSON.stringify(m, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${outPath}`);
}

async function cmdDiff(args: string[]): Promise<void> {
  const [runDir, baselineDir] = args;
  if (!runDir || !baselineDir) {
    console.error("Usage: bench diff <run-dir> <baseline-dir>");
    process.exit(2);
  }
  const { markdown } = diff(path.resolve(runDir), path.resolve(baselineDir));
  const outPath = path.join(path.resolve(runDir), "diff.md");
  writeFileSync(outPath, markdown, "utf-8");
  console.log(`Wrote ${outPath}`);
}

async function cmdMeasure(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  if (!flags.fixture || !flags.config) {
    console.error("Usage: bench measure --fixture <name> --config <dir-or-yaml> [--label <name>] [--baseline <dir>]");
    process.exit(2);
  }
  const benchRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const projectRoot = path.resolve(benchRoot, "..");

  // 1. Replay
  const result = await replay({
    fixture: flags.fixture,
    config: flags.config,
    label: flags.label,
    outDir: flags.out,
  });
  console.log(`Replay → ${result.outDir} (${(result.wallMs / 1000).toFixed(1)}s)`);

  // 2. Metrics
  const m = computeMetrics(result.outDir, projectRoot);
  writeFileSync(path.join(result.outDir, "metrics.json"), JSON.stringify(m, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${path.join(result.outDir, "metrics.json")}`);

  // 3. Diff (optional)
  if (flags.baseline) {
    const { markdown } = diff(result.outDir, path.resolve(flags.baseline));
    writeFileSync(path.join(result.outDir, "diff.md"), markdown, "utf-8");
    console.log(`Wrote ${path.join(result.outDir, "diff.md")}`);
  } else {
    console.log("(no --baseline given; skipping diff)");
  }
}

async function cmdReliability(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  if (!flags.fixture || !flags.config || flags.rate === undefined) {
    console.error("Usage: bench reliability --fixture <name> --config <dir-or-yaml> --rate <0..1> [--n 20] [--label <name>] [--no-mock]");
    process.exit(2);
  }
  const rate = parseFloat(flags.rate);
  const n = flags.n ? parseInt(flags.n, 10) : 20;
  const label = flags.label ?? `rate-${rate}-n${n}`;
  const useMock = flags["no-mock"] !== "true";

  const summary = await reliability({
    fixture: flags.fixture,
    config: flags.config,
    rate,
    n,
    label,
    mockSuccess: useMock,
  });

  console.log("");
  console.log(`Reliability summary: ${summary.runDir}`);
  console.log(`  fixture:         ${summary.fixture}`);
  console.log(`  rate:            ${summary.rate}`);
  console.log(`  n:               ${summary.n}`);
  console.log(`  successes:       ${summary.successes}`);
  console.log(`  failures:        ${summary.failures}`);
  console.log(`  completion_rate: ${(summary.completionRate * 100).toFixed(1)}%`);
  console.log(`  mock_success:    ${summary.mockSuccess}`);
  console.log(`  mean_wallMs:     ${summary.meanWallMs.toFixed(0)} (successes only)`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    process.exit(cmd ? 0 : 2);
  }
  switch (cmd) {
    case "extract": return cmdExtract(rest);
    case "replay":  await cmdReplay(rest); return;
    case "metrics": return cmdMetrics(rest);
    case "diff":    return cmdDiff(rest);
    case "measure": return cmdMeasure(rest);
    case "reliability": return cmdReliability(rest);
    default:
      console.error(`Unknown subcommand: ${cmd}\n`);
      console.log(HELP);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
