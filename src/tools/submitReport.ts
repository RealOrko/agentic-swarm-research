import fs from "node:fs";
import path from "node:path";
import slugify from "slugify";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";

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
    const report = args.report as string;
    const goal = (ctx.store.goal as string) || "research";

    const date = new Date().toISOString().split("T")[0];
    const slug = slugify(goal, { lower: true, strict: true }).slice(0, 60);
    const dirName = `${date}-${slug}`;

    const resultsDir = path.join(process.cwd(), "results", dirName);
    fs.mkdirSync(resultsDir, { recursive: true });

    // Write the report
    const reportPath = path.join(resultsDir, "report.md");
    fs.writeFileSync(reportPath, report, "utf-8");

    // Write the context trace
    const contextPath = path.join(resultsDir, "context.json");
    fs.writeFileSync(contextPath, JSON.stringify(ctx, null, 2), "utf-8");

    return {
      reportPath,
      contextPath,
      message: `Report written to ${reportPath}`,
    };
  },
};
