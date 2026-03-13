// Web search tool — queries SearXNG and auto-indexes results
export const schema = {
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
};

export async function handler(args, ctx) {
  const query = args.query;
  const searxngUrl = ctx.config.searxngUrl || "http://localhost:8080";
  const topResults = ctx.config.topResults || 8;

  const params = new URLSearchParams({
    q: query,
    format: "json",
    categories: "general",
  });

  try {
    const res = await ctx.fetch(`${searxngUrl}/search?${params}`);

    if (!res.ok) {
      return {
        query,
        error: `SearXNG returned ${res.status}: ${res.statusText}`,
        results: [],
      };
    }

    const data = await res.json();

    const results = data.results.slice(0, topResults).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      engine: r.engine,
    }));

    // Auto-index search snippets into knowledge store
    if (ctx.knowledgeStore) {
      for (const r of results) {
        if (r.snippet) {
          ctx.knowledgeStore
            .index(r.snippet, "search_snippet", r.url, {
              title: r.title,
              query,
            })
            .catch(() => {});
        }
      }
    }

    return { query, results };
  } catch (err) {
    return {
      query,
      error: err.message || String(err),
      results: [],
    };
  }
}
