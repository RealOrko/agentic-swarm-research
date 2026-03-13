// Semantic code search tool — queries vector-kv for relevant code chunks
export const schema = {
  type: "function",
  function: {
    name: "search_code",
    description:
      "Semantic search over the pre-indexed codebase. Returns the most relevant code chunks for a natural-language query.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language query describing what you're looking for",
        },
        num_results: {
          type: "number",
          description: "Number of results to return (default 5, max 20)",
        },
      },
      required: ["query"],
    },
  },
};

export async function handler(args, ctx) {
  const query = args.query;
  const vectorKey = ctx.vectorKey;
  const k = Math.min(
    Math.max(args.num_results || ctx.config.numResults || 5, 1),
    ctx.config.numResultsCap || 20,
  );

  if (!vectorKey) {
    return { error: "search_code requires vectorKey to be configured", results: [] };
  }

  try {
    const output = ctx.exec(
      "vector-kv",
      ["get", vectorKey, "-q", query, "-k", String(k)],
      { encoding: "utf-8", timeout: ctx.config.timeoutMs || 30000 },
    );

    const results = JSON.parse(output);
    const formatted = results.map((r) => ({
      content: r.content,
      relevance: Math.round((1 - r.distance) * 100) / 100,
    }));

    return { query, results: formatted };
  } catch (err) {
    return { query, error: err.message || String(err), results: [] };
  }
}
