import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addNode, getRootId } from "./context.js";
import type { Context } from "./context.js";
import { spawnAgent, buildWorkerEnv } from "./worker-pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const synthesizerPrompt = fs.readFileSync(
  path.join(__dirname, "prompts/synthesizer.md"),
  "utf-8"
);

interface Finding {
  question: string;
  answer: string;
  sources: string[];
}

function pairUp<T>(items: T[]): T[][] {
  const pairs: T[][] = [];
  for (let i = 0; i < items.length; i += 2) {
    if (i + 1 < items.length) {
      pairs.push([items[i], items[i + 1]]);
    } else {
      pairs.push([items[i]]);
    }
  }
  return pairs;
}

function formatFindings(findings: Finding[], goal: string): string {
  const findingsText = findings
    .map(
      (f, i) =>
        `## Finding ${i + 1}: ${f.question}\n\n${f.answer}\n\nSources: ${f.sources.join(", ")}`
    )
    .join("\n\n---\n\n");

  return `Original goal: ${goal}\n\nResearch findings:\n\n${findingsText}`;
}

async function synthesizePair(
  findings: Finding[],
  goal: string,
  ctx: Context,
  parentNodeId: string,
  roundLabel: string
): Promise<Finding> {
  const workerResult = await spawnAgent({
    name: `synthesizer-${roundLabel}`,
    systemPrompt: synthesizerPrompt,
    userMessage: formatFindings(findings, goal),
    maxIterations: 3,
    allowTextResponse: true,
    sessionId: ctx.sessionId,
    tools: [],
    env: buildWorkerEnv(),
  });

  const result = workerResult.result;

  // Collect all sources from inputs
  const allSources = findings.flatMap((f) => f.sources);

  addNode(ctx, {
    type: "synthesis",
    parentId: parentNodeId,
    content: result,
    source: `tournament-${roundLabel}`,
    metadata: { inputCount: findings.length },
  });

  return {
    question: `Intermediate synthesis (${roundLabel})`,
    answer: result,
    sources: [...new Set(allSources)],
  };
}

/**
 * Tournament-style synthesis: pairs findings, synthesizes each pair,
 * then recurses on intermediate results. Max 3 levels deep (handles ~27 findings).
 */
export async function tournamentSynthesize(
  goal: string,
  findings: Finding[],
  ctx: Context,
  depth: number = 0
): Promise<string> {
  const rootId = getRootId(ctx);

  // Base case: 3 or fewer findings, single-pass synthesis
  if (findings.length <= 3 || depth >= 3) {
    const parentNode = addNode(ctx, {
      type: "synthesis",
      parentId: rootId,
      content: null,
      source: "tournament-final",
      summary: `Final synthesis of ${findings.length} findings`,
    });

    const workerResult = await spawnAgent({
      name: "synthesizer",
      systemPrompt: synthesizerPrompt,
      userMessage: formatFindings(findings, goal),
      maxIterations: 3,
      allowTextResponse: true,
      sessionId: ctx.sessionId,
      tools: [],
      env: buildWorkerEnv(),
    });

    const result = workerResult.result;

    // Update the node with the synthesis content
    ctx.db.updateNodeContent(
      ctx.sessionId,
      parentNode.id,
      result,
      result.length > 300 ? result.slice(0, 300) + "..." : result,
      Math.ceil(result.length / 3)
    );

    return result;
  }

  // Tournament round: pair up and synthesize
  const pairs = pairUp(findings);
  const roundLabel = `round-${depth + 1}`;

  const roundNode = addNode(ctx, {
    type: "synthesis",
    parentId: rootId,
    content: null,
    source: `tournament-${roundLabel}`,
    summary: `Tournament ${roundLabel}: ${pairs.length} pairs from ${findings.length} findings`,
  });

  const intermediates = await Promise.all(
    pairs.map((pair, i) =>
      synthesizePair(pair, goal, ctx, roundNode.id, `${roundLabel}-pair${i + 1}`)
    )
  );

  // Recurse on intermediate results
  return tournamentSynthesize(goal, intermediates, ctx, depth + 1);
}
