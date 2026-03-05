import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentLoop } from "../agent-loop.js";
import {
  createListFilesTool,
  createReadFileTool,
  createGrepCodeTool,
} from "./codeTools.js";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codeResearcherPrompt = fs.readFileSync(
  path.join(__dirname, "../prompts/code-researcher.md"),
  "utf-8"
);

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
            description:
              "Your detailed answer based on code analysis",
          },
          sources: {
            type: "array",
            items: { type: "string" },
            description:
              "List of file paths examined (e.g. 'src/main.ts:10-50')",
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

export function createResearchCodeTool(repoPath: string): ToolHandler {
  return {
    definition: {
      type: "function",
      function: {
        name: "research_code",
        description:
          "Research a specific question by examining the codebase. A code research agent will explore files, search for patterns, and read source code to answer the question. Use this for questions about how code works, what patterns exist, or how to improve the codebase.",
        parameters: {
          type: "object",
          properties: {
            question: {
              type: "string",
              description:
                "The specific question to investigate in the codebase",
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

      const tools = [
        createListFilesTool(repoPath),
        createReadFileTool(repoPath),
        createGrepCodeTool(repoPath),
        submitFindingTool,
      ];

      const result = await agentLoop({
        name: "code-researcher",
        systemPrompt: codeResearcherPrompt,
        tools,
        userMessage: `Investigate the following question about the codebase at ${repoPath}:\n\n${question}`,
        ctx,
        maxIterations: 10,
      });

      try {
        return JSON.parse(result);
      } catch {
        return { answer: result, sources: [] };
      }
    },
  };
}
