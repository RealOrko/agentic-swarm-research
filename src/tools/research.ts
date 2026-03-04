import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentLoop } from "../agent-loop.js";
import { webSearchTool } from "./webSearch.js";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const researcherPrompt = fs.readFileSync(
  path.join(__dirname, "../prompts/researcher.md"),
  "utf-8"
);

const submitFindingTool: ToolHandler = {
  definition: {
    type: "function",
    function: {
      name: "submit_finding",
      description:
        "Submit your research finding for this question. Call this once you have gathered enough information to answer the question.",
      parameters: {
        type: "object",
        properties: {
          answer: {
            type: "string",
            description: "Your detailed answer to the research question",
          },
          sources: {
            type: "array",
            items: { type: "string" },
            description: "List of source URLs used",
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

export const researchQuestionTool: ToolHandler = {
  definition: {
    type: "function",
    function: {
      name: "research_question",
      description:
        "Research a specific question by delegating to a research agent that can search the web. Returns a detailed finding with sources.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The specific research question to investigate",
          },
        },
        required: ["question"],
      },
    },
  },

  handler: async (
    args: Record<string, unknown>,
    ctx: Context
  ): Promise<unknown> => {
    const question = args.question as string;

    const result = await agentLoop({
      name: `researcher`,
      systemPrompt: researcherPrompt,
      tools: [webSearchTool, submitFindingTool],
      userMessage: `Research the following question thoroughly:\n\n${question}`,
      ctx,
      maxIterations: 10,
    });

    // Try to parse structured result if the agent returned JSON
    try {
      return JSON.parse(result);
    } catch {
      return { answer: result, sources: [] };
    }
  },
};
