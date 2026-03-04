import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentLoop } from "../agent-loop.js";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const criticPrompt = fs.readFileSync(
  path.join(__dirname, "../prompts/critic.md"),
  "utf-8"
);

const submitCritiqueTool: ToolHandler = {
  terminates: true,
  definition: {
    type: "function",
    function: {
      name: "submit_critique",
      description:
        "Submit your critique of the synthesis. Set approved to true if the synthesis adequately addresses the research goal, or false if there are significant gaps.",
      parameters: {
        type: "object",
        properties: {
          approved: {
            type: "boolean",
            description: "Whether the synthesis is adequate",
          },
          feedback: {
            type: "string",
            description:
              "Detailed feedback on the synthesis quality, gaps, and suggestions",
          },
          gaps: {
            type: "array",
            items: { type: "string" },
            description:
              "Specific gaps or questions that need further research",
          },
        },
        required: ["approved", "feedback", "gaps"],
      },
    },
  },

  handler: async (args: Record<string, unknown>): Promise<unknown> => {
    return {
      approved: args.approved,
      feedback: args.feedback,
      gaps: args.gaps,
    };
  },
};

export const critiqueTool: ToolHandler = {
  definition: {
    type: "function",
    function: {
      name: "critique",
      description:
        "Have an independent critic review the synthesis against the original research goal. Returns approval status and any identified gaps.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The original research goal",
          },
          synthesis: {
            type: "string",
            description: "The synthesis to critique",
          },
        },
        required: ["goal", "synthesis"],
      },
    },
  },

  handler: async (
    args: Record<string, unknown>,
    ctx: Context
  ): Promise<unknown> => {
    const goal = args.goal as string;
    const synthesis = args.synthesis as string;

    const result = await agentLoop({
      name: "critic",
      systemPrompt: criticPrompt,
      tools: [submitCritiqueTool],
      userMessage: `Original research goal: ${goal}\n\nSynthesis to review:\n\n${synthesis}`,
      ctx,
      maxIterations: 3,
    });

    try {
      return JSON.parse(result);
    } catch {
      return { approved: true, feedback: result, gaps: [] };
    }
  },
};
