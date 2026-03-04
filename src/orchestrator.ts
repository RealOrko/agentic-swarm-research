import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentLoop } from "./agent-loop.js";
import { Context, createContext, setStore } from "./context.js";
import { researchQuestionTool } from "./tools/research.js";
import { synthesizeFindingsTool } from "./tools/synthesize.js";
import { critiqueTool } from "./tools/critique.js";
import { submitReportTool } from "./tools/submitReport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const orchestratorPrompt = fs.readFileSync(
  path.join(__dirname, "prompts/orchestrator.md"),
  "utf-8"
);

export async function runResearch(goal: string): Promise<Context> {
  const ctx = createContext();
  setStore(ctx, "goal", goal, "system");

  console.log(`\n🔬 Starting research: "${goal}"\n`);

  await agentLoop({
    name: "orchestrator",
    systemPrompt: orchestratorPrompt,
    tools: [
      researchQuestionTool,
      synthesizeFindingsTool,
      critiqueTool,
      submitReportTool,
    ],
    userMessage: `Research goal: ${goal}`,
    ctx,
    maxIterations: 30,
  });

  return ctx;
}
