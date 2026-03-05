import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentLoop } from "./agent-loop.js";
import { Context, createContext, setStore } from "./context.js";
import { researchQuestionTool } from "./tools/research.js";
import { synthesizeFindingsTool } from "./tools/synthesize.js";
import { critiqueTool } from "./tools/critique.js";
import { submitReportTool, writeReport } from "./tools/submitReport.js";
import { createResearchCodeTool } from "./tools/researchCode.js";
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

  // Extract findings from tool results
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

  // Check for synthesis
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

  return sections.join("\n");
}

export async function runResearch(
  goal: string,
  repoPath?: string
): Promise<Context> {
  const ctx = createContext();
  setStore(ctx, "goal", goal, "system");

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
    console.log(`\n🔬 Starting research: "${goal}"`);
    console.log(`📂 Codebase: ${resolvedRepo}\n`);
  } else {
    console.log(`\n🔬 Starting research: "${goal}"\n`);
  }

  const result = await agentLoop({
    name: "orchestrator",
    systemPrompt: orchestratorPrompt + promptAddendum,
    tools,
    userMessage: `Research goal: ${goal}`,
    ctx,
    maxIterations: 30,
  });

  // Check if submit_final_report was called
  const reportSubmitted = ctx.events.some(
    (e) => e.tool === "submit_final_report" && e.type === "tool_call"
  );

  if (!reportSubmitted) {
    console.log(
      "\n⚠️  Orchestrator exited without submitting a report. Writing partial results..."
    );
    const partialReport = buildPartialReport(ctx);
    const { reportPath } = writeReport(partialReport, ctx);
    console.log(`   Partial report written to: ${reportPath}`);
  }

  return ctx;
}
