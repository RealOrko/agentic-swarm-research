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
        "Synthesize all research findings into a coherent summary. Automatically collects findings from the session — no parameters needed.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  handler: async (
    args: Record<string, unknown>,
    ctx: Context
  ): Promise<unknown> => {
    const goal = (ctx.store.goal as string) || "Unknown goal";

    // Auto-extract findings from context DB
    const findingNodes = ctx.db.getNodesByType(ctx.sessionId, "finding");
    const findings: Array<{ question: string; answer: string; sources: string[] }> = [];
    for (const node of findingNodes) {
      if (node.content) {
        findings.push({
          question: node.summary || "Research finding",
          answer: node.content,
          sources: (node.metadata.sources as string[]) || [],
        });
      }
    }

    if (findings.length === 0) {
      return { error: "No findings available to synthesize. Run research first." };
    }

    const result = await tournamentSynthesize(goal, findings, ctx);

    const synthNode = addNode(ctx, {
      type: "synthesis",
      parentId: ctx.store._rootId as string,
      content: result,
      source: "synthesize_findings",
      summary: result.length > 300 ? result.slice(0, 300) + "..." : result,
    });

    return { synthesis: result, _nodeId: synthNode.id };
  },
};
