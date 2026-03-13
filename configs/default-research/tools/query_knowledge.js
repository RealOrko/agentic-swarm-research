// Query knowledge tool — search the session knowledge store
export const schema = {
  type: "function",
  function: {
    name: "query_knowledge",
    description:
      "Search the knowledge base for information gathered during this research session. Returns relevant chunks from code files, web pages, and search results.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for",
        },
        source_type: {
          type: "string",
          enum: ["code", "web_page", "search_snippet", "grep_match"],
          description: "Optional: filter by source type",
        },
        top_k: {
          type: "number",
          description: "Number of results (default 5, max 10)",
        },
      },
      required: ["query"],
    },
  },
};

export async function handler(args, ctx) {
  if (!ctx.knowledgeStore) {
    return { error: "Knowledge store not initialized", results: [] };
  }

  const topK = Math.min(args.top_k || ctx.config.topK || 5, ctx.config.topKCap || 10);

  const results = await ctx.knowledgeStore.query(
    args.query,
    topK,
    args.source_type ? { source_type: args.source_type } : undefined,
  );

  return {
    query: args.query,
    results: results.map((r) => ({
      text: r.text,
      source_type: r.source_type,
      source_ref: r.source_ref,
      metadata: JSON.parse(r.metadata || "{}"),
    })),
  };
}
