import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentLoop } from "./agent-loop.js";
import { Context, createContext, setStore } from "./context.js";
import { discoverModel } from "./llm.js";
import { KnowledgeStore } from "./knowledge-store.js";
import { researchQuestionTool } from "./tools/research.js";
import { synthesizeFindingsTool } from "./tools/synthesize.js";
import { critiqueTool } from "./tools/critique.js";
import { submitReportTool, writeReport } from "./tools/submitReport.js";
import { createResearchCodeTool } from "./tools/researchCode.js";
import { getPoolStats, resetPoolStats } from "./worker-pool.js";
import { log, logRaw } from "./logger.js";
import type { ToolHandler } from "./agent-loop.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const orchestratorPrompt = fs.readFileSync(
  path.join(__dirname, "prompts/orchestrator.md"),
  "utf-8"
);

function buildPartialReport(ctx: Context): string {
  const goal = (ctx.store.goal as string) || "Unknown goal";
  const sections: string[] = [
    `# Partial Research Report (max iterations reached)`,
    ``,
    `**Goal:** ${goal}`,
    ``,
    `> This report was generated automatically because the orchestrator hit its iteration limit before calling submit_final_report.`,
    ``,
  ];

  // Try to extract findings from tree nodes first
  const treeFindings: Array<{ content: string; source: string; sources: string[] }> = [];
  const treeSyntheses: string[] = [];

  for (const node of ctx.tree.nodes.values()) {
    if (node.type === "finding") {
      const content = node.content || node.summary;
      const sources = (node.metadata.sources as string[]) || [];
      treeFindings.push({ content, source: node.source, sources });
    } else if (node.type === "synthesis" && node.content) {
      treeSyntheses.push(node.content);
    }
  }

  if (treeFindings.length > 0) {
    sections.push(`## Research Findings`, ``);
    for (const f of treeFindings) {
      sections.push(`### Finding (via ${f.source})`, ``, f.content, ``);
      if (f.sources.length > 0) {
        sections.push(`**Sources:** ${f.sources.join(", ")}`, ``);
      }
      sections.push(`---`, ``);
    }
  } else {
    // Fallback to events for backward compatibility
    const findings = ctx.events.filter(
      (e) =>
        e.type === "tool_result" &&
        (e.tool === "research_question" || e.tool === "research_code") &&
        e.output &&
        typeof e.output === "object"
    );

    if (findings.length > 0) {
      sections.push(`## Research Findings`, ``);
      for (const f of findings) {
        const output = f.output as Record<string, unknown>;
        const answer = (output.answer as string) || JSON.stringify(output);
        const sources = (output.sources as string[]) || [];
        sections.push(`### Finding (via ${f.tool})`, ``, answer, ``);
        if (sources.length > 0) {
          sections.push(`**Sources:** ${sources.join(", ")}`, ``);
        }
        sections.push(`---`, ``);
      }
    }
  }

  // Check for synthesis — tree first, then events fallback
  if (treeSyntheses.length > 0) {
    sections.push(`## Synthesis`, ``, treeSyntheses[treeSyntheses.length - 1], ``);
  } else {
    const syntheses = ctx.events.filter(
      (e) =>
        e.type === "tool_result" &&
        e.tool === "synthesize_findings" &&
        e.output
    );

    if (syntheses.length > 0) {
      const last = syntheses[syntheses.length - 1];
      const output = last.output as Record<string, unknown>;
      const synthesis = (output.synthesis as string) || JSON.stringify(output);
      sections.push(`## Synthesis`, ``, synthesis, ``);
    }
  }

  return sections.join("\n");
}

export async function runResearch(
  goal: string,
  repoPath?: string
): Promise<Context> {
  // Discover model capabilities before starting
  await discoverModel();

  const ctx = createContext();
  setStore(ctx, "goal", goal, "system");

  // Initialize knowledge store for grounding agent responses
  const kb = await KnowledgeStore.create();
  ctx.knowledgeStore = kb;
  log("system", "Knowledge store initialized");

  const runStart = Date.now();
  resetPoolStats();

  const tools: ToolHandler[] = [
    researchQuestionTool,
    synthesizeFindingsTool,
    critiqueTool,
    submitReportTool,
  ];

  let promptAddendum = "";

  if (repoPath) {
    const resolvedRepo = path.resolve(repoPath);
    setStore(ctx, "repo", resolvedRepo, "system");
    tools.unshift(createResearchCodeTool(resolvedRepo));
    promptAddendum = `\n\nA codebase is available for analysis at: ${resolvedRepo}\nUse \`research_code\` for questions about the code and \`research_question\` for web research.`;
    log("system", `Starting research: "${goal}"`);
    log("system", `Codebase: ${resolvedRepo}`);
  } else {
    log("system", `Starting research: "${goal}"`);
  }

  const { result, stats: orchestratorStats } = await agentLoop({
    name: "orchestrator",
    systemPrompt: orchestratorPrompt + promptAddendum,
    tools,
    userMessage: `Research goal: ${goal}`,
    ctx,
    maxIterations: 100,
  });

  // Print run summary
  const runDuration = Date.now() - runStart;
  const poolStats = getPoolStats();
  const totalPrompt = poolStats.totalPromptTokens + orchestratorStats.promptTokens;
  const totalCompletion = poolStats.totalCompletionTokens + orchestratorStats.completionTokens;
  const formatDur = (ms: number) => {
    const secs = Math.round(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  };
  const fmtTok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  logRaw("");
  logRaw(`  ── Summary ────────────────────────────────────────────`);
  logRaw(`  Duration:    ${formatDur(runDuration)}`);
  logRaw(`  Workers:     ${poolStats.spawned} spawned, ${poolStats.completed} completed, ${poolStats.failed} failed`);
  logRaw(`  Tokens:      ~${fmtTok(totalPrompt)} prompt, ~${fmtTok(totalCompletion)} completion`);
  logRaw(`  Orchestrator: ${orchestratorStats.iterations} iters, ~${fmtTok(orchestratorStats.promptTokens + orchestratorStats.completionTokens)} tokens`);
  logRaw(`  ──────────────────────────────────────────────────────`);
  logRaw("");

  // Check if submit_final_report was called
  const reportSubmitted = ctx.events.some(
    (e) => e.tool === "submit_final_report" && e.type === "tool_call"
  );

  if (!reportSubmitted) {
    log("system", "Orchestrator exited without submitting a report. Writing partial results...");
    const partialReport = buildPartialReport(ctx);
    const { reportPath } = writeReport(partialReport, ctx);
    log("system", `Partial report written to: ${reportPath}`);
  }

  return ctx;
}
