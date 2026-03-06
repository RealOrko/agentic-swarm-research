import fs from "node:fs";
import path from "node:path";
import slugify from "slugify";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";
import { serializeTree, getTreeTokens } from "../context.js";

export function writeReport(
  report: string,
  ctx: Context
): { reportPath: string; contextPath: string } {
  const goal = (ctx.store.goal as string) || "research";

  const date = new Date().toISOString().split("T")[0];
  const slug = slugify(goal, { lower: true, strict: true }).slice(0, 60);
  const dirName = `${date}-${slug}`;

  const resultsDir = path.join(process.cwd(), "results", dirName);
  fs.mkdirSync(resultsDir, { recursive: true });

  const reportPath = path.join(resultsDir, "report.md");
  fs.writeFileSync(reportPath, report, "utf-8");

  // Serialize context with tree structure and metrics
  const contextData = {
    store: ctx.store,
    events: ctx.events,
    tree: serializeTree(ctx.tree),
    metrics: {
      totalTreeNodes: ctx.tree.nodes.size,
      treeTokens: getTreeTokens(ctx),
      totalEvents: ctx.events.length,
    },
  };

  const contextPath = path.join(resultsDir, "context.json");
  fs.writeFileSync(contextPath, JSON.stringify(contextData, null, 2), "utf-8");

  return { reportPath, contextPath };
}

export const submitReportTool: ToolHandler = {
  terminates: true,
  definition: {
    type: "function",
    function: {
      name: "submit_final_report",
      description:
        "Submit the final research report. This writes the report as a markdown file to the results folder and ends the research session.",
      parameters: {
        type: "object",
        properties: {
          report: {
            type: "string",
            description:
              "The final research report in markdown format",
          },
        },
        required: ["report"],
      },
    },
  },

  handler: async (
    args: Record<string, unknown>,
    ctx: Context
  ): Promise<unknown> => {
    // Use the latest synthesis from the context tree instead of the model's arg
    // This prevents the model from hallucinating a new report
    let report = args.report as string;

    const syntheses = [...ctx.tree.nodes.values()]
      .filter((n) => n.type === "synthesis" && n.content && n.content.length > 100)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    if (syntheses.length > 0) {
      report = syntheses[0].content!;
    }

    const { reportPath, contextPath } = writeReport(report, ctx);

    return {
      reportPath,
      contextPath,
      message: `Report written to ${reportPath}`,
    };
  },
};
