import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentLoop } from "./agent-loop.js";
import { addNode } from "./context.js";
import type { Context } from "./context.js";
import { createQueryKnowledgeTool } from "./tools/queryKnowledge.js";

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

/** Strip leading chain-of-thought before the actual markdown content */
function stripLeadingThought(text: string): string {
  // Find the first markdown heading
  const mdStart = text.search(/^#{1,3}\s/m);
  if (mdStart > 0) return text.slice(mdStart);
  // Or first line that starts with "**" (bold section header)
  const boldStart = text.search(/^\*\*/m);
  if (boldStart > 0) return text.slice(boldStart);
  return text;
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
  const rawResult = await agentLoop({
    name: `synthesizer-${roundLabel}`,
    systemPrompt: synthesizerPrompt,
    tools: [createQueryKnowledgeTool()],
    userMessage: formatFindings(findings, goal),
    ctx,
    maxIterations: 10,
    parentNodeId,
    allowTextResponse: true,
  });

  const result = stripLeadingThought(rawResult);

  // Collect all sources from inputs
  const allSources = findings.flatMap((f) => f.sources);

  const synthNode = addNode(ctx, {
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
  // Base case: 3 or fewer findings, single-pass synthesis
  if (findings.length <= 3 || depth >= 3) {
    const parentNode = addNode(ctx, {
      type: "synthesis",
      parentId: ctx.tree.rootId,
      content: null,
      source: "tournament-final",
      summary: `Final synthesis of ${findings.length} findings`,
    });

    const rawResult = await agentLoop({
      name: "synthesizer",
      systemPrompt: synthesizerPrompt,
      tools: [createQueryKnowledgeTool()],
      userMessage: formatFindings(findings, goal),
      ctx,
      maxIterations: 10,
      parentNodeId: parentNode.id,
      allowTextResponse: true,
    });

    const result = stripLeadingThought(rawResult);

    parentNode.content = result;
    parentNode.summary = result.length > 300 ? result.slice(0, 300) + "..." : result;

    return result;
  }

  // Tournament round: pair up and synthesize
  const pairs = pairUp(findings);
  const roundLabel = `round-${depth + 1}`;

  const roundNode = addNode(ctx, {
    type: "synthesis",
    parentId: ctx.tree.rootId,
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
