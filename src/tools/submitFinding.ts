import type { ToolHandler } from "../agent-loop.js";

export function createSubmitFindingTool(): ToolHandler {
  return {
    definition: {
      type: "function",
      function: {
        name: "submit_finding",
        description:
          "Submit your research finding. Call this once you have gathered enough information.",
        parameters: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              description: "Your detailed answer",
            },
            sources: {
              type: "array",
              items: { type: "string" },
              description: "List of sources used",
            },
          },
          required: ["answer", "sources"],
        },
      },
    },
    terminates: true,
    handler: async (args: Record<string, unknown>) => {
      return { answer: args.answer, sources: args.sources };
    },
  };
}
