// Submit critique — terminal tool that ends the critic agent loop
export const schema = {
  type: "function",
  function: {
    name: "submit_critique",
    description: "Submit your critique of the synthesis.",
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
};

export async function handler(args) {
  return {
    approved: args.approved,
    feedback: args.feedback,
    gaps: args.gaps,
  };
}
