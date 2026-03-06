import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";
import { addNode } from "../context.js";
import { tournamentSynthesize } from "../tournament.js";

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

    const result = await tournamentSynthesize(goal, findings, ctx);

    const synthNode = addNode(ctx, {
      type: "synthesis",
      parentId: ctx.tree.rootId,
      content: result,
      source: "synthesize_findings",
      summary: result.length > 300 ? result.slice(0, 300) + "..." : result,
    });

    return { synthesis: result, _nodeId: synthNode.id };
  },
};
