import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentLoop } from "../agent-loop.js";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const synthesizerPrompt = fs.readFileSync(
  path.join(__dirname, "../prompts/synthesizer.md"),
  "utf-8"
);

export const synthesizeFindingsTool: ToolHandler = {
  definition: {
    type: "function",
    function: {
      name: "synthesize_findings",
      description:
        "Synthesize multiple research findings into a coherent, comprehensive summary. Call this after all research questions have been answered.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The original research goal",
          },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                answer: { type: "string" },
                sources: {
                  type: "array",
                  items: { type: "string" },
                },
              },
            },
            description: "The research findings to synthesize",
          },
        },
        required: ["goal", "findings"],
      },
    },
  },

  handler: async (
    args: Record<string, unknown>,
    ctx: Context
  ): Promise<unknown> => {
    const goal = args.goal as string;
    const findings = args.findings as Array<{
      question: string;
      answer: string;
      sources: string[];
    }>;

    const findingsText = findings
      .map(
        (f, i) =>
          `## Finding ${i + 1}: ${f.question}\n\n${f.answer}\n\nSources: ${f.sources.join(", ")}`
      )
      .join("\n\n---\n\n");

    const result = await agentLoop({
      name: "synthesizer",
      systemPrompt: synthesizerPrompt,
      tools: [],
      userMessage: `Original goal: ${goal}\n\nResearch findings:\n\n${findingsText}`,
      ctx,
      maxIterations: 1,
    });

    return { synthesis: result };
  },
};
