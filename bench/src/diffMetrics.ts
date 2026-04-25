/**
 * diffMetrics — compare a run's metrics.json against a baseline's metrics.json.
 *
 * Usage:
 *   tsx bench/src/diffMetrics.ts <run-dir> <baseline-dir>
 *
 * Writes <run-dir>/diff.md and prints a summary table to stdout.
 *
 * Direction column: ↑ = run > baseline, ↓ = run < baseline, = unchanged.
 * "Better/Worse" is metric-specific (e.g. fewer pseudo-citations is better).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Metrics } from "./computeMetrics.js";

type Direction = "lower-is-better" | "higher-is-better" | "neutral";

interface Row {
  metric: string;
  baseline: number;
  run: number;
  delta: number;
  pctDelta: number | null;
  direction: Direction;
  verdict: "better" | "worse" | "same" | "n/a";
}

function load(dir: string): Metrics {
  return JSON.parse(readFileSync(path.join(dir, "metrics.json"), "utf-8")) as Metrics;
}

function row(
  metric: string,
  baseline: number,
  run: number,
  direction: Direction,
): Row {
  const delta = run - baseline;
  const pctDelta = baseline === 0 ? null : (delta / baseline) * 100;
  let verdict: Row["verdict"] = "same";
  if (delta !== 0) {
    if (direction === "lower-is-better") verdict = delta < 0 ? "better" : "worse";
    else if (direction === "higher-is-better") verdict = delta > 0 ? "better" : "worse";
    else verdict = "n/a";
  }
  return { metric, baseline, run, delta, pctDelta, direction, verdict };
}

function build(baseline: Metrics, run: Metrics): Row[] {
  const rows: Row[] = [];

  // Source quality — fewer/cleaner is better
  rows.push(row("sources.total", baseline.sources.total, run.sources.total, "lower-is-better"));
  rows.push(row("sources.uniqueNormalized", baseline.sources.uniqueNormalized, run.sources.uniqueNormalized, "neutral"));
  rows.push(row("sources.duplicateRatio", +baseline.sources.duplicateRatio.toFixed(3), +run.sources.duplicateRatio.toFixed(3), "lower-is-better"));

  // Junk markers — fewer is better
  rows.push(row("pseudoCitations.count", baseline.pseudoCitations.count, run.pseudoCitations.count, "lower-is-better"));

  // Codebase grounding — more is better (specifically when codebase is in scope)
  rows.push(row("codeRefs.count", baseline.codeRefs.count, run.codeRefs.count, "higher-is-better"));

  // Fabrication — fewer novel numerics is better
  rows.push(row("numericClaims.total", baseline.numericClaims.total, run.numericClaims.total, "neutral"));
  rows.push(row("numericClaims.novel", baseline.numericClaims.novel, run.numericClaims.novel, "lower-is-better"));

  // Cost / speed
  rows.push(row("wallMs", baseline.run.wallMs, run.run.wallMs, "lower-is-better"));
  rows.push(row("totalPromptTokens", baseline.run.totalPromptTokens, run.run.totalPromptTokens, "lower-is-better"));
  rows.push(row("totalCompletionTokens", baseline.run.totalCompletionTokens, run.run.totalCompletionTokens, "lower-is-better"));
  rows.push(row("finalReportTokens", baseline.run.finalReportTokens, run.run.finalReportTokens, "neutral"));
  rows.push(row("workersFailed", baseline.run.workersFailed, run.run.workersFailed, "lower-is-better"));

  return rows;
}

function arrow(verdict: Row["verdict"]): string {
  switch (verdict) {
    case "better": return "✓";
    case "worse":  return "✗";
    case "same":   return "=";
    case "n/a":    return "·";
  }
}

function fmtDelta(r: Row): string {
  const sign = r.delta > 0 ? "+" : "";
  const pct = r.pctDelta === null ? "" : ` (${r.pctDelta > 0 ? "+" : ""}${r.pctDelta.toFixed(1)}%)`;
  return `${sign}${r.delta}${pct}`;
}

function renderMarkdown(rows: Row[], baseline: Metrics, run: Metrics): string {
  const lines: string[] = [];
  lines.push(`# Metrics diff: \`${run.run.label}\` vs \`${baseline.run.label}\``);
  lines.push("");
  lines.push(`- Fixture:      ${run.run.fixture}${run.run.fixture !== baseline.run.fixture ? ` (baseline: ${baseline.run.fixture})` : ""}`);
  lines.push(`- Baseline run: \`${baseline.run.sessionId}\` (${baseline.run.config})`);
  lines.push(`- This run:     \`${run.run.sessionId}\` (${run.run.config})`);
  lines.push("");
  lines.push("| Metric | Baseline | Run | Δ | Verdict |");
  lines.push("|---|---:|---:|---:|:---:|");
  for (const r of rows) {
    lines.push(`| ${r.metric} | ${r.baseline} | ${r.run} | ${fmtDelta(r)} | ${arrow(r.verdict)} ${r.verdict} |`);
  }
  lines.push("");

  // Round-growth comparison (best-effort: align by round name)
  if (baseline.roundGrowth.length || run.roundGrowth.length) {
    lines.push("## Round growth");
    lines.push("");
    lines.push("| Round | Baseline in→out (ratio) | Run in→out (ratio) |");
    lines.push("|---|---|---|");
    const allRounds = new Set([
      ...baseline.roundGrowth.map((r) => r.round),
      ...run.roundGrowth.map((r) => r.round),
    ]);
    for (const round of allRounds) {
      const b = baseline.roundGrowth.find((r) => r.round === round);
      const a = run.roundGrowth.find((r) => r.round === round);
      const fmt = (r?: typeof baseline.roundGrowth[number]) =>
        r ? `${r.inputTokens}→${r.outputTokens} (${r.ratio.toFixed(2)})` : "—";
      lines.push(`| ${round} | ${fmt(b)} | ${fmt(a)} |`);
    }
    lines.push("");
  }

  // Source duplicates (top offenders)
  if (run.sources.duplicates.length) {
    lines.push("## Source-list duplicates (this run)");
    lines.push("");
    for (const d of run.sources.duplicates.slice(0, 10)) {
      lines.push(`- ${d.count}× \`${d.url}\``);
    }
    lines.push("");
  }

  // Novel numeric claims sample
  if (run.numericClaims.novelSamples.length) {
    lines.push("## Novel numeric claims (this run, not in fixture findings)");
    lines.push("");
    for (const s of run.numericClaims.novelSamples) {
      lines.push(`- \`${s}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function diff(runDir: string, baselineDir: string): { rows: Row[]; markdown: string } {
  const baseline = load(baselineDir);
  const run = load(runDir);
  const rows = build(baseline, run);
  const markdown = renderMarkdown(rows, baseline, run);
  return { rows, markdown };
}

function main(): void {
  const [runDir, baselineDir] = process.argv.slice(2);
  if (!runDir || !baselineDir) {
    console.error("Usage: tsx bench/src/diffMetrics.ts <run-dir> <baseline-dir>");
    process.exit(2);
  }
  const { rows, markdown } = diff(path.resolve(runDir), path.resolve(baselineDir));
  const outPath = path.join(path.resolve(runDir), "diff.md");
  writeFileSync(outPath, markdown, "utf-8");
  console.log(`Wrote ${outPath}`);
  console.log("");
  for (const r of rows) {
    const v = arrow(r.verdict);
    const m = r.metric.padEnd(28);
    console.log(`  ${v} ${m} ${String(r.baseline).padStart(8)} → ${String(r.run).padStart(8)}   ${fmtDelta(r)}`);
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
