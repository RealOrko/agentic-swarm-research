/**
 * computeMetrics — analyze a replay run and emit metrics.json.
 *
 * Reads:
 *   <run-dir>/report.md
 *   <run-dir>/trace.json
 *   <run-dir>/run.json
 *   The fixture referenced by trace.json (for novelty checks)
 *
 * Writes:
 *   <run-dir>/metrics.json
 *
 * Metrics produced:
 *   sources_total, sources_unique_normalized, sources_duplicate_ratio
 *   pseudo_citations (count + samples)
 *   code_refs (count + unique paths)
 *   numeric_claims (count + novel list — claims not present as substrings in any fixture finding)
 *   round_growth (per-round output/input token ratio)
 *   wall_time_ms, total_prompt_tokens, total_completion_tokens
 *   final_report_tokens
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface TraceRound {
  id: string;
  parentId: string | null;
  source: string;
  summary: string;
  content: string | null;
  tokenEstimate: number;
  timestamp: string;
  metadata: Record<string, unknown>;
}

interface Trace {
  sessionId: string;
  fixture: string;
  fixturePath: string;
  config: string;
  label: string;
  wallMs: number;
  poolStats: {
    spawned: number;
    completed: number;
    failed: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
  };
  fixtureFindings: Array<{
    idx: number;
    question: string;
    answerLength: number;
    tokenEstimate: number;
    sourcesCount: number;
  }>;
  rounds: TraceRound[];
}

interface Fixture {
  findings: Array<{ question: string; answer: string; sources: string[] }>;
}

export interface Metrics {
  run: {
    fixture: string;
    config: string;
    label: string;
    sessionId: string;
    wallMs: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    finalReportLength: number;
    finalReportTokens: number;
    workersSpawned: number;
    workersCompleted: number;
    workersFailed: number;
  };
  sources: {
    total: number;
    uniqueNormalized: number;
    duplicateRatio: number;
    duplicates: Array<{ url: string; count: number }>;
  };
  pseudoCitations: {
    count: number;
    samples: string[];
  };
  codeRefs: {
    count: number;
    uniquePaths: string[];
  };
  numericClaims: {
    total: number;
    novel: number;
    novelSamples: string[];
  };
  roundGrowth: Array<{
    round: string;
    inputTokens: number;
    outputTokens: number;
    ratio: number;
    pairCount: number;
  }>;
}

// ── Report parsing ──────────────────────────────────────────────────

/**
 * Split a markdown report into prose + sources block. The Sources section is
 * everything after the last heading whose text matches /^sources?$/i, until
 * EOF or the next heading at the same level.
 */
function splitProseAndSources(report: string): { prose: string; sources: string } {
  const lines = report.split("\n");
  let sourcesStart = -1;
  let sourcesLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s+(.+?)\s*$/);
    if (m && /^sources?$/i.test(m[2])) {
      sourcesStart = i;
      sourcesLevel = m[1].length;
    }
  }
  if (sourcesStart === -1) {
    return { prose: report, sources: "" };
  }
  // Find end: next heading at same-or-shallower level, or EOF
  let sourcesEnd = lines.length;
  for (let i = sourcesStart + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s+/);
    if (m && m[1].length <= sourcesLevel) {
      sourcesEnd = i;
      break;
    }
  }
  return {
    prose: lines.slice(0, sourcesStart).concat(lines.slice(sourcesEnd)).join("\n"),
    sources: lines.slice(sourcesStart + 1, sourcesEnd).join("\n"),
  };
}

// ── Source-list metrics ─────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s)\]>"']+/g;
const CODE_REF_RE = /`([^`]+)`/g;

/** Pull one canonical reference per source-list line. URL > backtick path > raw line text. */
function extractSourceItems(sourcesBlock: string): string[] {
  const items: string[] = [];
  for (const rawLine of sourcesBlock.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // Numbered list item
    const m = line.match(/^\d+\.\s+(.*)$/);
    if (!m) continue;
    const body = m[1];

    const url = body.match(URL_RE);
    if (url) {
      items.push(url[0]);
      continue;
    }
    const code = body.match(CODE_REF_RE);
    if (code) {
      // strip the backticks
      items.push(code[0].replace(/^`|`$/g, ""));
      continue;
    }
    items.push(body);
  }
  return items;
}

function normalizeUrl(s: string): string {
  if (!/^https?:\/\//i.test(s)) {
    // file path — normalize whitespace + trailing slash + line range
    return s.trim().replace(/\/+$/, "");
  }
  try {
    const u = new URL(s);
    u.hash = "";
    // strip noisy tracking params
    const drop: string[] = [];
    u.searchParams.forEach((_v, k) => {
      if (/^utm_|^ref$|^src$|^source$/i.test(k)) drop.push(k);
    });
    for (const k of drop) u.searchParams.delete(k);
    let out = u.toString();
    out = out.replace(/\/+$/, "");
    return out.toLowerCase();
  } catch {
    return s.trim();
  }
}

function computeSourceMetrics(sourcesBlock: string): Metrics["sources"] {
  const items = extractSourceItems(sourcesBlock);
  const counts = new Map<string, number>();
  for (const it of items) {
    const n = normalizeUrl(it);
    counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()]
    .filter(([, c]) => c > 1)
    .map(([url, count]) => ({ url, count }))
    .sort((a, b) => b.count - a.count);
  const total = items.length;
  const unique = counts.size;
  return {
    total,
    uniqueNormalized: unique,
    duplicateRatio: total > 0 ? 1 - unique / total : 0,
    duplicates,
  };
}

// ── Pseudo-citation detection ───────────────────────────────────────

const PSEUDO_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "bracket-marker", re: /【[^】]+】/g },
  { name: "page-line", re: /†L\d+(?:-\d+)?/g },
  { name: "finding-ref", re: /\bFinding\s+\d+\b/g },
];

function computePseudoCitations(prose: string): Metrics["pseudoCitations"] {
  const samples: string[] = [];
  let count = 0;
  for (const { re } of PSEUDO_PATTERNS) {
    const matches = prose.match(re);
    if (matches) {
      count += matches.length;
      for (const m of matches) {
        if (samples.length < 20 && !samples.includes(m)) samples.push(m);
      }
    }
  }
  return { count, samples };
}

// ── Code-reference detection ────────────────────────────────────────

const CODE_PATH_RE = /(?<![/\w@])((?:[\w-]+\/)+[\w-]+\.[a-zA-Z]{1,6}(?::\d+(?:-\d+)?)?)\b/g;

function computeCodeRefs(prose: string): Metrics["codeRefs"] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = CODE_PATH_RE.exec(prose)) !== null) {
    found.add(m[1]);
  }
  return {
    count: found.size,
    uniquePaths: [...found].sort(),
  };
}

// ── Numeric-claim novelty ───────────────────────────────────────────

// Match numbers that are real values (not markdown list markers like "1.").
// Allow a decimal point only if followed by more digits; allow trailing thousands separators.
const NUMERIC_RE = /(?<![\w.])(\d{1,3}(?:[,]\d{3})+|\d+(?:\.\d+)?)\s?(ms|MB|KB|GB|TB|kHz|Hz|dim|%|kB|µs|us|ns|s|x|×)?(?!\w)/g;

function computeNumericClaims(prose: string, fixture: Fixture): Metrics["numericClaims"] {
  const findingsText = fixture.findings.map((f) => f.answer).join("\n");
  const claims = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = NUMERIC_RE.exec(prose)) !== null) {
    const num = m[1];
    const unit = m[2] ?? "";
    // Filter out trivial single digits with no unit — too noisy (years, list refs)
    if (num.length === 1 && !unit) continue;
    const claim = (num + (unit ? " " + unit : "")).trim();
    claims.add(claim);
  }
  const novel: string[] = [];
  for (const c of claims) {
    const num = c.split(" ")[0];
    const unit = c.split(" ")[1] ?? "";
    // Tier 1: exact "<num> <unit>" substring (with or without space)
    if (unit) {
      if (
        findingsText.includes(`${num} ${unit}`) ||
        findingsText.includes(`${num}${unit}`) ||
        findingsText.includes(`${num} ${unit}`) ||
        findingsText.includes(`${num} ${unit}`)
      ) continue;
    }
    // Tier 2: bare number as standalone token in findings
    const tokenRe = new RegExp(`\\b${num.replace(/[.()*+?^$|[\]\\]/g, "\\$&")}\\b`);
    if (tokenRe.test(findingsText)) continue;
    novel.push(c);
  }
  return {
    total: claims.size,
    novel: novel.length,
    novelSamples: novel.slice(0, 30).sort(),
  };
}

// ── Per-round token growth ──────────────────────────────────────────

function computeRoundGrowth(trace: Trace): Metrics["roundGrowth"] {
  // Group synthesis nodes by round identifier extracted from source.
  // Sources look like:
  //   "tournament-round-1"             (header, no content)
  //   "tournament-round-1-pair3"       (per-pair output)
  //   "tournament-final"               (final output)
  // Base-case-only runs have just "tournament-final".
  const fixtureInputTokens = trace.fixtureFindings.reduce((s, f) => s + f.tokenEstimate, 0);

  type Bucket = { round: string; pairs: number; outputTokens: number };
  const byRound = new Map<string, Bucket>();

  for (const r of trace.rounds) {
    const m = r.source.match(/^tournament-(round-\d+)(-pair\d+)?$|^tournament-(final)$/);
    if (!m) continue;
    const round = m[3] ?? m[1]; // "round-N" or "final"
    if (!byRound.has(round)) byRound.set(round, { round, pairs: 0, outputTokens: 0 });
    const b = byRound.get(round)!;
    if (r.content) {
      b.pairs += 1;
      b.outputTokens += r.tokenEstimate;
    }
  }

  // Order rounds: round-1, round-2, ..., final
  const ordered = [...byRound.values()].sort((a, b) => {
    if (a.round === "final") return 1;
    if (b.round === "final") return -1;
    return a.round.localeCompare(b.round, undefined, { numeric: true });
  });

  const result: Metrics["roundGrowth"] = [];
  let prevOutputTokens = fixtureInputTokens;
  for (const b of ordered) {
    const inputTokens = prevOutputTokens;
    result.push({
      round: b.round,
      inputTokens,
      outputTokens: b.outputTokens,
      ratio: inputTokens > 0 ? b.outputTokens / inputTokens : 0,
      pairCount: b.pairs,
    });
    prevOutputTokens = b.outputTokens;
  }
  return result;
}

// ── Top-level driver ────────────────────────────────────────────────

export function computeMetrics(runDir: string, projectRoot: string): Metrics {
  const reportPath = path.join(runDir, "report.md");
  const tracePath = path.join(runDir, "trace.json");
  const runInfoPath = path.join(runDir, "run.json");

  const report = readFileSync(reportPath, "utf-8");
  const trace = JSON.parse(readFileSync(tracePath, "utf-8")) as Trace;
  const runInfo = JSON.parse(readFileSync(runInfoPath, "utf-8"));

  const fixturePath = path.isAbsolute(trace.fixturePath)
    ? trace.fixturePath
    : path.resolve(projectRoot, trace.fixturePath);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as Fixture;

  const { prose, sources } = splitProseAndSources(report);

  return {
    run: {
      fixture: trace.fixture,
      config: trace.config,
      label: trace.label,
      sessionId: trace.sessionId,
      wallMs: trace.wallMs,
      totalPromptTokens: trace.poolStats.totalPromptTokens,
      totalCompletionTokens: trace.poolStats.totalCompletionTokens,
      finalReportLength: report.length,
      finalReportTokens: runInfo.finalReportTokens,
      workersSpawned: trace.poolStats.spawned,
      workersCompleted: trace.poolStats.completed,
      workersFailed: trace.poolStats.failed,
    },
    sources: computeSourceMetrics(sources),
    pseudoCitations: computePseudoCitations(prose),
    codeRefs: computeCodeRefs(prose),
    numericClaims: computeNumericClaims(prose, fixture),
    roundGrowth: computeRoundGrowth(trace),
  };
}

function main(): void {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("Usage: tsx bench/src/computeMetrics.ts <run-dir>");
    process.exit(2);
  }
  const benchRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const projectRoot = path.resolve(benchRoot, "..");
  const m = computeMetrics(path.resolve(runDir), projectRoot);
  const outPath = path.join(path.resolve(runDir), "metrics.json");
  writeFileSync(outPath, JSON.stringify(m, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${outPath}`);
  console.log(`  sources:         total=${m.sources.total} unique=${m.sources.uniqueNormalized} dup_ratio=${m.sources.duplicateRatio.toFixed(2)}`);
  console.log(`  pseudo-cites:    ${m.pseudoCitations.count}`);
  console.log(`  code-refs:       ${m.codeRefs.count}`);
  console.log(`  numeric-claims:  ${m.numericClaims.total} (${m.numericClaims.novel} novel)`);
  console.log(`  rounds:          ${m.roundGrowth.length}`);
  for (const r of m.roundGrowth) {
    console.log(`    ${r.round.padEnd(8)} in=~${r.inputTokens} out=~${r.outputTokens} ratio=${r.ratio.toFixed(2)} pairs=${r.pairCount}`);
  }
  console.log(`  wall_time_ms:    ${m.run.wallMs}`);
  console.log(`  tokens (p/c):    ${m.run.totalPromptTokens}/${m.run.totalCompletionTokens}`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
