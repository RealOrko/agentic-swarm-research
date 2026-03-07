import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";
import { addNode } from "../context.js";
import { spawnAgent, buildWorkerEnv } from "../worker-pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const researcherPrompt = fs.readFileSync(
  path.join(__dirname, "../prompts/researcher.md"),
  "utf-8"
);

export const researchQuestionTool: ToolHandler = {
  definition: {
    type: "function",
    function: {
      name: "research_question",
      description:
        "Research a specific question by delegating to a research agent that can search the web. Returns a detailed finding with sources.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The specific research question to investigate",
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

    // Create sub_question node in the tree
    const sqNode = addNode(ctx, {
      type: "sub_question",
      parentId: ctx.store._rootId as string,
      content: question,
      source: "research_question",
      summary: question.length > 300 ? question.slice(0, 300) + "..." : question,
    });

    const workerResult = await spawnAgent({
      name: "researcher",
      systemPrompt: researcherPrompt,
      userMessage: `Research the following question thoroughly:\n\n${question}`,
      maxIterations: 15,
      sessionId: ctx.sessionId,
      tools: [
        { type: "web_search" },
        { type: "fetch_page" },
        { type: "query_knowledge" },
        { type: "submit_finding" },
      ],
      env: buildWorkerEnv(),
    });

    // Try to parse structured result if the agent returned JSON
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(workerResult.result);
    } catch {
      parsed = { answer: workerResult.result, sources: [] };
    }

    // If sources are empty, extract them from events in the DB
    let sources = (parsed.sources as string[]) || [];
    if (sources.length === 0) {
      const searchEvents = ctx.db.queryEvents(ctx.sessionId, "tool_result", "web_search");
      const searchUrls = searchEvents
        .flatMap((e) => {
          const output = e.output as Record<string, unknown>;
          const results = (output?.results as Array<Record<string, unknown>>) || [];
          return results.map((r) => r.url as string).filter(Boolean);
        });

      const fetchEvents = ctx.db.queryEvents(ctx.sessionId, "tool_call", "fetch_page");
      const fetchedUrls = fetchEvents
        .map((e) => (e.input as Record<string, unknown>)?.url as string)
        .filter(Boolean);

      sources = [...new Set([...fetchedUrls, ...searchUrls])];
    }

    // Create finding node
    const findingContent = (parsed.answer as string) || workerResult.result;
    const findingNode = addNode(ctx, {
      type: "finding",
      parentId: sqNode.id,
      content: findingContent,
      source: "research_question",
      metadata: { sources },
    });

    return { ...parsed, _nodeId: findingNode.id };
  },
};
