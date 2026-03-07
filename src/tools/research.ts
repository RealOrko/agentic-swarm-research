import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";
import { addNode } from "../context.js";
import { spawnAgent, mergeWorkerResult, buildWorkerEnv } from "../worker-pool.js";

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
      parentId: ctx.tree.rootId,
      content: question,
      source: "research_question",
      summary: question.length > 300 ? question.slice(0, 300) + "..." : question,
    });

    const workerResult = await spawnAgent({
      name: "researcher",
      systemPrompt: researcherPrompt,
      userMessage: `Research the following question thoroughly:\n\n${question}`,
      maxIterations: 100,
      tools: [
        { type: "web_search" },
        { type: "fetch_page" },
        { type: "query_knowledge" },
        { type: "submit_finding" },
      ],
      env: buildWorkerEnv(),
    });

    await mergeWorkerResult(ctx, workerResult, sqNode.id);

    // Try to parse structured result if the agent returned JSON
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(workerResult.result);
    } catch {
      parsed = { answer: workerResult.result, sources: [] };
    }

    // If sources are empty, extract them from returned events (web_search URLs, fetch_page URLs)
    let sources = (parsed.sources as string[]) || [];
    if (sources.length === 0) {
      const searchUrls = workerResult.events
        .filter(
          (e) =>
            e.source === "researcher" &&
            e.type === "tool_result" &&
            e.tool === "web_search" &&
            e.output
        )
        .flatMap((e) => {
          const output = e.output as Record<string, unknown>;
          const results = (output.results as Array<Record<string, unknown>>) || [];
          return results.map((r) => r.url as string).filter(Boolean);
        });

      const fetchedUrls = workerResult.events
        .filter(
          (e) =>
            e.source === "researcher" &&
            e.type === "tool_call" &&
            e.tool === "fetch_page" &&
            e.input
        )
        .map((e) => (e.input as Record<string, unknown>).url as string)
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
