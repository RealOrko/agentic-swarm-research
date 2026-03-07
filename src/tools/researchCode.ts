import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";
import { addNode } from "../context.js";
import { exploreCodebase, buildUnits, getRepoFiles } from "../code-exploration.js";

let invocationCounter = 0;

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
      const invocationId = ++invocationCounter;
      const labelPrefix = `cr${invocationId}`;

      // Create top-level sub_question node
      const sqNode = addNode(ctx, {
        type: "sub_question",
        parentId: ctx.tree.rootId,
        content: question,
        source: "research_code",
        summary: question.length > 300 ? question.slice(0, 300) + "..." : question,
      });

      // Get file list and build exploration units
      const files = getRepoFiles(repoPath);
      const units = buildUnits(files, repoPath);

      // Recursively explore the codebase
      const findings = await exploreCodebase(
        question,
        units,
        repoPath,
        ctx,
        sqNode.id,
        0,
        labelPrefix
      );

      // Combine all findings into a single result
      const combinedAnswer = findings.map((f) => f.answer).join("\n\n---\n\n");
      const allSources = [...new Set(findings.flatMap((f) => f.sources))];

      // Create top-level finding node
      const findingNode = addNode(ctx, {
        type: "finding",
        parentId: sqNode.id,
        content: combinedAnswer,
        source: "research_code",
        metadata: { sources: allSources },
      });

      return {
        answer: combinedAnswer,
        sources: allSources,
        _nodeId: findingNode.id,
      };
    },
  };
}
