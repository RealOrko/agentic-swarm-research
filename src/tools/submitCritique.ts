import type { ToolHandler } from "../agent-loop.js";

export function createSubmitCritiqueTool(): ToolHandler {
  return {
    definition: {
      type: "function",
      function: {
        name: "submit_critique",
        description:
          "Submit your critique of the synthesis.",
        parameters: {
          type: "object",
          properties: {
            approved: {
              type: "boolean",
              description: "Whether the synthesis is adequate",
            },
            feedback: {
              type: "string",
              description: "Detailed feedback",
            },
            gaps: {
              type: "array",
              items: { type: "string" },
              description: "Specific gaps needing further research",
            },
          },
          required: ["approved", "feedback", "gaps"],
        },
      },
    },
    terminates: true,
    handler: async (args: Record<string, unknown>) => {
      return {
        approved: args.approved,
        feedback: args.feedback,
        gaps: args.gaps,
      };
    },
  };
}
