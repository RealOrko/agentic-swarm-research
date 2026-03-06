import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { agentLoop } from "./agent-loop.js";
import {
  createListFilesTool,
  createReadFileTool,
  createGrepCodeTool,
} from "./tools/codeTools.js";
import { createQueryKnowledgeTool } from "./tools/queryKnowledge.js";
import { tournamentSynthesize } from "./tournament.js";
import { addNode } from "./context.js";
import type { Context } from "./context.js";
import type { ToolHandler } from "./agent-loop.js";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codeResearcherPrompt = fs.readFileSync(
  path.join(__dirname, "prompts/code-researcher.md"),
  "utf-8"
);

export interface ExplorationUnit {
  path: string;
  startLine?: number;
  endLine?: number;
  lineCount: number;
}

const LINE_THRESHOLD = 2000;
const MAX_DEPTH = 3;
const CHUNK_SIZE = 80;

/** Count lines in a file efficiently */
function countLines(filePath: string): number {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content.split("\n").length;
  } catch {
    return 0;
  }
}

/** Build exploration units from a list of file paths */
export function buildUnits(files: string[], repoPath: string): ExplorationUnit[] {
  const units: ExplorationUnit[] = [];

  for (const file of files) {
    const fullPath = path.join(repoPath, file);
    const lineCount = countLines(fullPath);
    if (lineCount === 0) continue;

    if (lineCount <= 100) {
      units.push({ path: file, lineCount });
    } else {
      // Split large files into ~80-line chunks
      for (let start = 1; start <= lineCount; start += CHUNK_SIZE) {
        const end = Math.min(start + CHUNK_SIZE - 1, lineCount);
        units.push({
          path: file,
          startLine: start,
          endLine: end,
          lineCount: end - start + 1,
        });
      }
    }
  }

  return units;
}

/** Group units by their file's parent directory */
function groupByDirectory(units: ExplorationUnit[]): Map<string, ExplorationUnit[]> {
  const groups = new Map<string, ExplorationUnit[]>();
  for (const unit of units) {
    const dir = path.dirname(unit.path);
    const existing = groups.get(dir);
    if (existing) {
      existing.push(unit);
    } else {
      groups.set(dir, [unit]);
    }
  }
  return groups;
}

/** Total line count across units */
function totalWeight(units: ExplorationUnit[]): number {
  return units.reduce((sum, u) => sum + u.lineCount, 0);
}

/** Split units into roughly equal-weight batches */
function splitIntoBatches(units: ExplorationUnit[], maxWeight: number): ExplorationUnit[][] {
  const batches: ExplorationUnit[][] = [];
  let current: ExplorationUnit[] = [];
  let currentWeight = 0;

  for (const unit of units) {
    if (currentWeight + unit.lineCount > maxWeight && current.length > 0) {
      batches.push(current);
      current = [];
      currentWeight = 0;
    }
    current.push(unit);
    currentWeight += unit.lineCount;
  }
  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

/** Format a unit list for inclusion in a prompt */
function formatUnitList(units: ExplorationUnit[]): string {
  const lines: string[] = [];
  for (const u of units) {
    if (u.startLine !== undefined && u.endLine !== undefined) {
      lines.push(`- ${u.path} (lines ${u.startLine}-${u.endLine})`);
    } else {
      lines.push(`- ${u.path} (${u.lineCount} lines)`);
    }
  }
  return lines.join("\n");
}

interface Finding {
  question: string;
  answer: string;
  sources: string[];
}

const submitFindingTool: ToolHandler = {
  definition: {
    type: "function",
    function: {
      name: "submit_finding",
      description:
        "Submit your code research finding. Call this once you have gathered enough information from the codebase to answer the question.",
      parameters: {
        type: "object",
        properties: {
          answer: {
            type: "string",
            description: "Your detailed answer based on code analysis",
          },
          sources: {
            type: "array",
            items: { type: "string" },
            description: "List of file paths examined (e.g. 'src/main.ts:10-50')",
          },
        },
        required: ["answer", "sources"],
      },
    },
  },
  terminates: true,
  handler: async (args: Record<string, unknown>): Promise<unknown> => {
    return { answer: args.answer, sources: args.sources };
  },
};

/** Spawn a leaf code-researcher agent for a set of units */
async function exploreLeaf(
  question: string,
  units: ExplorationUnit[],
  repoPath: string,
  ctx: Context,
  parentNodeId: string,
  label: string
): Promise<Finding> {
  const unitList = formatUnitList(units);
  const userMessage =
    `Investigate the following question about the codebase at ${repoPath}:\n\n${question}\n\n` +
    `## Your assigned files\n\nFocus your analysis on these files/sections:\n${unitList}\n\n` +
    `You have full repo access via grep_code and read_file — use them to follow imports and references beyond your assigned area.`;

  const tools = [
    createListFilesTool(repoPath),
    createReadFileTool(repoPath),
    createGrepCodeTool(repoPath),
    createQueryKnowledgeTool(),
    submitFindingTool,
  ];

  const sqNode = addNode(ctx, {
    type: "sub_question",
    parentId: parentNodeId,
    content: question,
    source: `code-researcher-${label}`,
    summary: `Code exploration: ${label} (${units.length} units, ${totalWeight(units)} lines)`,
  });

  const result = await agentLoop({
    name: `code-researcher-${label}`,
    systemPrompt: codeResearcherPrompt,
    tools,
    userMessage,
    ctx,
    maxIterations: 10,
    parentNodeId: sqNode.id,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result);
  } catch {
    parsed = { answer: result, sources: [] };
  }

  const findingContent = (parsed.answer as string) || result;

  // Validate sources: only keep paths the agent actually read via read_file
  const agentSource = `code-researcher-${label}`;
  const actualReads = ctx.events
    .filter(
      (e) =>
        e.source === agentSource &&
        e.tool === "read_file" &&
        e.type === "tool_call" &&
        e.input
    )
    .map((e) => {
      const input = e.input as Record<string, unknown>;
      return (input.path as string) || (input.file_path as string) || "";
    })
    .filter(Boolean);

  const reportedSources = (parsed.sources as string[]) || [];
  const validatedSources = reportedSources.filter((s) => {
    const basePath = s.split(":")[0]; // strip line range
    return actualReads.some(
      (r) => r === basePath || r.endsWith(basePath) || basePath.endsWith(r)
    );
  });

  addNode(ctx, {
    type: "finding",
    parentId: sqNode.id,
    content: findingContent,
    source: agentSource,
    metadata: { sources: validatedSources, droppedSources: reportedSources.length - validatedSources.length },
  });

  return {
    question: `Code exploration: ${label}`,
    answer: findingContent,
    sources: validatedSources,
  };
}

/**
 * Recursively explore a codebase by dividing files into groups,
 * spawning parallel agents, and merging findings via tournament synthesis.
 */
export async function exploreCodebase(
  question: string,
  units: ExplorationUnit[],
  repoPath: string,
  ctx: Context,
  parentNodeId: string,
  depth: number = 0
): Promise<Finding[]> {
  const weight = totalWeight(units);

  // Base case: small enough for a single agent, or max depth reached
  if (weight <= LINE_THRESHOLD || depth >= MAX_DEPTH) {
    const label = depth === 0 ? "root" : `d${depth}-leaf`;
    const finding = await exploreLeaf(question, units, repoPath, ctx, parentNodeId, label);
    return [finding];
  }

  // Recursive case: group by directory
  const groups = groupByDirectory(units);

  // If grouping produces only 1 group, split into equal-weight batches instead
  let partitions: ExplorationUnit[][];
  if (groups.size === 1) {
    partitions = splitIntoBatches(units, LINE_THRESHOLD);
  } else {
    // Further split any groups that exceed threshold
    partitions = [];
    for (const [dir, groupUnits] of groups) {
      if (totalWeight(groupUnits) <= LINE_THRESHOLD) {
        partitions.push(groupUnits);
      } else {
        // Recurse will handle splitting at next depth
        partitions.push(groupUnits);
      }
    }
  }

  // Explore each partition in parallel
  const allFindings = await Promise.all(
    partitions.map((partition, i) => {
      // Derive a label from the common directory
      const dirs = [...new Set(partition.map((u) => path.dirname(u.path)))];
      const label = dirs.length === 1 ? dirs[0] : `group-${i + 1}`;

      if (totalWeight(partition) > LINE_THRESHOLD && depth + 1 < MAX_DEPTH) {
        // Recurse deeper
        return exploreCodebase(question, partition, repoPath, ctx, parentNodeId, depth + 1);
      } else {
        // Leaf exploration
        return exploreLeaf(question, partition, repoPath, ctx, parentNodeId, label).then((f) => [f]);
      }
    })
  );

  // Flatten findings from all partitions
  const findings = allFindings.flat();

  // Merge if we have many findings at this level
  if (findings.length > 3 && depth < MAX_DEPTH) {
    const merged = await tournamentSynthesize(
      question,
      findings,
      ctx,
      0
    );
    return [
      {
        question: `Merged code exploration (depth ${depth})`,
        answer: merged,
        sources: findings.flatMap((f) => f.sources),
      },
    ];
  }

  return findings;
}

/** Get the list of tracked files in a repo */
export function getRepoFiles(repoPath: string): string[] {
  try {
    const isGit = fs.existsSync(path.join(repoPath, ".git"));
    if (isGit) {
      const output = execSync("git ls-files", {
        cwd: repoPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return output.trim().split("\n").filter(Boolean);
    }
  } catch {
    // Fall through to find
  }

  try {
    const output = execSync(
      "find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' | head -500",
      { cwd: repoPath, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((f) => f.replace(/^\.\//, ""));
  } catch {
    return [];
  }
}
