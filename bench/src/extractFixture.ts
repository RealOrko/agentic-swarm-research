/**
 * extractFixture — turn a real run's context.json into a replayable synthesis fixture.
 *
 * Usage:
 *   tsx bench/src/extractFixture.ts <path-to-context.json> <fixture-name>
 *
 * Writes:
 *   bench/fixtures/<fixture-name>/goal.txt
 *   bench/fixtures/<fixture-name>/findings.json
 *   bench/fixtures/<fixture-name>/source-context.json   (copy, for traceability)
 *
 * Only "research_question" findings are kept. Critique findings are dropped —
 * they belong in a separate critique-replay fixture.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";

interface RawNode {
  id: string;
  type: string;
  parentId: string | null;
  childIds: string[];
  summary: string;
  content: string | null;
  source: string;
  metadata: Record<string, unknown>;
}

interface RawContext {
  store: { goal?: string; [k: string]: unknown };
  tree: { rootId: string; nodes: Record<string, RawNode> };
}

export interface FixtureFinding {
  question: string;
  answer: string;
  sources: string[];
  /** Provenance — the original node id, so we can re-trace if needed. */
  origNodeId: string;
}

export interface Fixture {
  goal: string;
  findings: FixtureFinding[];
  /** Provenance — where this fixture was extracted from. */
  origContextPath: string;
  extractedAt: string;
}

export function extractFixture(contextJsonPath: string): Fixture {
  const raw = JSON.parse(readFileSync(contextJsonPath, "utf8")) as RawContext;
  const goal = (raw.store?.goal as string) || "";
  if (!goal) {
    throw new Error(`No goal found in store of ${contextJsonPath}`);
  }

  const nodes = raw.tree.nodes;
  const findings: FixtureFinding[] = [];

  for (const node of Object.values(nodes)) {
    if (node.type !== "finding") continue;
    if (node.source !== "research_question") continue;

    const parent = node.parentId ? nodes[node.parentId] : null;
    const question =
      parent && parent.type === "sub_question"
        ? (parent.content || parent.summary || "").trim()
        : "(unknown question)";

    const answer = (node.content || "").trim();
    if (!answer) continue;

    const sources = Array.isArray(node.metadata?.sources)
      ? (node.metadata.sources as unknown[]).filter((s): s is string => typeof s === "string")
      : [];

    findings.push({
      question,
      answer,
      sources,
      origNodeId: node.id,
    });
  }

  return {
    goal,
    findings,
    origContextPath: path.resolve(contextJsonPath),
    extractedAt: new Date().toISOString(),
  };
}

function main(): void {
  const [contextPath, fixtureName] = process.argv.slice(2);
  if (!contextPath || !fixtureName) {
    console.error("Usage: tsx bench/src/extractFixture.ts <context.json> <fixture-name>");
    process.exit(2);
  }

  const fixture = extractFixture(contextPath);

  const benchRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const outDir = path.join(benchRoot, "fixtures", fixtureName);
  mkdirSync(outDir, { recursive: true });

  writeFileSync(path.join(outDir, "goal.txt"), fixture.goal + "\n", "utf8");
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
    "utf8",
  );
  copyFileSync(contextPath, path.join(outDir, "source-context.json"));

  const totalSources = fixture.findings.reduce((acc, f) => acc + f.sources.length, 0);
  console.log(`Wrote fixture "${fixtureName}" to ${outDir}`);
  console.log(`  goal:     ${fixture.goal.slice(0, 80)}${fixture.goal.length > 80 ? "..." : ""}`);
  console.log(`  findings: ${fixture.findings.length}`);
  console.log(`  sources:  ${totalSources} (across all findings, pre-dedupe)`);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
