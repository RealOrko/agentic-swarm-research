import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";

export function createQueryKnowledgeTool(): ToolHandler {
  return {
    definition: {
      type: "function",
      function: {
        name: "query_knowledge",
        description:
          "Search the knowledge base for information gathered during this research session. Returns relevant chunks from code files, web pages, and search results that have already been read or fetched. Use this to verify claims or find evidence before submitting findings.",
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
    },

    handler: async (
      args: Record<string, unknown>,
      ctx: Context
    ): Promise<unknown> => {
      if (!ctx.knowledgeStore) {
        return { error: "Knowledge store not initialized", results: [] };
      }

      const results = await ctx.knowledgeStore.query(
        args.query as string,
        Math.min((args.top_k as number) || 5, 10),
        args.source_type
          ? { source_type: args.source_type as string }
          : undefined
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
    },
  };
}
