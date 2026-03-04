import "dotenv/config";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";

const SEARXNG_URL = process.env.SEARXNG_URL || "http://localhost:8080";

interface SearXNGResult {
  title: string;
  url: string;
  content: string;
  engine: string;
}

interface SearXNGResponse {
  results: SearXNGResult[];
}

export const webSearchTool: ToolHandler = {
  definition: {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web. Returns a list of results with titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query",
          },
        },
        required: ["query"],
      },
    },
  },

  handler: async (
    args: Record<string, unknown>,
    _ctx: Context
  ): Promise<unknown> => {
    const query = args.query as string;
    const params = new URLSearchParams({
      q: query,
      format: "json",
      categories: "general",
    });

    try {
      const res = await fetch(`${SEARXNG_URL}/search?${params}`);

      if (!res.ok) {
        return {
          query,
          error: `SearXNG returned ${res.status}: ${res.statusText}`,
          results: [],
        };
      }

      const data = (await res.json()) as SearXNGResponse;

      const topResults = data.results.slice(0, 8).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        engine: r.engine,
      }));

      return { query, results: topResults };
    } catch (err) {
      return {
        query,
        error: err instanceof Error ? err.message : String(err),
        results: [],
      };
    }
  },
};
