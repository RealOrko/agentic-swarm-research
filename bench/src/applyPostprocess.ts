/**
 * applyPostprocess — apply the production dedupeSources function to a frozen
 * report and re-compute metrics. Used to prove the post-processor's effect
 * on already-collected runs without burning more LLM calls.
 *
 * Usage:
 *   tsx bench/src/applyPostprocess.ts <run-or-baseline-dir>
 *
 * Writes:
 *   <dir>/report.postprocessed.md
 *   <dir>/metrics.postprocessed.json
 *   <dir>/postprocess.diff.md   (compares pre vs post on the same dir)
 */

import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { dedupeSources } from "../../src/synthesis/postprocess.js";
import { computeMetrics } from "./computeMetrics.js";
import { diff } from "./diffMetrics.js";

function main(): void {
  const inDir = process.argv[2];
  if (!inDir) {
    console.error("Usage: tsx bench/src/applyPostprocess.ts <run-or-baseline-dir>");
    process.exit(2);
  }
  const absDir = path.resolve(inDir);
  const benchRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const projectRoot = path.resolve(benchRoot, "..");

  const reportPath = path.join(absDir, "report.md");
  const original = readFileSync(reportPath, "utf-8");
  const { result: processed, deduped } = dedupeSources(original);

  const newReportPath = path.join(absDir, "report.postprocessed.md");
  writeFileSync(newReportPath, processed, "utf-8");

  // Build a temp "run" dir so computeMetrics sees the post-processed report
  // alongside this dir's trace + run + fixture references. Cleanest: copy the
  // metadata files into a sibling temp dir, swap report.md, and run metrics.
  const tmp = mkdtempSync(path.join(tmpdir(), "bench-pp-"));
  copyFileSync(path.join(absDir, "trace.json"), path.join(tmp, "trace.json"));
  copyFileSync(path.join(absDir, "run.json"), path.join(tmp, "run.json"));
  writeFileSync(path.join(tmp, "report.md"), processed, "utf-8");

  const newMetrics = computeMetrics(tmp, projectRoot);
  const newMetricsPath = path.join(absDir, "metrics.postprocessed.json");
  writeFileSync(newMetricsPath, JSON.stringify(newMetrics, null, 2) + "\n", "utf-8");

  // Diff the post-processed metrics against the original metrics from the same dir.
  // Use the temp dir as "run" and the original dir as "baseline".
  // For diffMetrics to read from each, both need a metrics.json present.
  // Original dir already has metrics.json. Temp dir needs metrics.json too.
  writeFileSync(path.join(tmp, "metrics.json"), JSON.stringify(newMetrics, null, 2) + "\n", "utf-8");
  const { markdown } = diff(tmp, absDir);
  const diffPath = path.join(absDir, "postprocess.diff.md");
  writeFileSync(diffPath, markdown, "utf-8");

  console.log(`Post-processed: ${absDir}`);
  console.log(`  duplicates removed: ${deduped}`);
  console.log(`  report:   ${newReportPath}`);
  console.log(`  metrics:  ${newMetricsPath}`);
  console.log(`  diff:     ${diffPath}`);
  console.log("");
  console.log(`  before → after`);
  console.log(`    sources.total:          ${readFileSync(path.join(absDir, "metrics.json"), "utf-8").match(/"total":\s*(\d+)/)?.[1]} → ${newMetrics.sources.total}`);
  console.log(`    sources.uniqueNorm:     ${readFileSync(path.join(absDir, "metrics.json"), "utf-8").match(/"uniqueNormalized":\s*(\d+)/)?.[1]} → ${newMetrics.sources.uniqueNormalized}`);
  console.log(`    sources.duplicateRatio: ${JSON.parse(readFileSync(path.join(absDir, "metrics.json"), "utf-8")).sources.duplicateRatio.toFixed(3)} → ${newMetrics.sources.duplicateRatio.toFixed(3)}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
