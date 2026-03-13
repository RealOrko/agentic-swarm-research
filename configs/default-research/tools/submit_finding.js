// Submit finding — terminal tool that ends the researcher agent loop
export const schema = {
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
};

export async function handler(args) {
  return { answer: args.answer, sources: args.sources };
}
