import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";
import { spawnAgent, mergeWorkerResult, buildWorkerEnv } from "../worker-pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const criticPrompt = fs.readFileSync(
  path.join(__dirname, "../prompts/critic.md"),
  "utf-8"
);

export const critiqueTool: ToolHandler = {
  definition: {
    type: "function",
    function: {
      name: "critique",
      description:
        "Have an independent critic review the synthesis against the original research goal. Returns approval status and any identified gaps.",
      parameters: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "The original research goal",
          },
          synthesis: {
            type: "string",
            description: "The synthesis to critique",
          },
        },
        required: ["goal", "synthesis"],
      },
    },
  },

  handler: async (
    args: Record<string, unknown>,
    ctx: Context
  ): Promise<unknown> => {
    const goal = args.goal as string;
    const synthesis = args.synthesis as string;

    const workerResult = await spawnAgent({
      name: "critic",
      systemPrompt: criticPrompt,
      userMessage: `Original research goal: ${goal}\n\nSynthesis to review:\n\n${synthesis}`,
      maxIterations: 3,
      tools: [{ type: "submit_critique" }],
      env: buildWorkerEnv(),
    });

    await mergeWorkerResult(ctx, workerResult, ctx.tree.rootId);

    const result = workerResult.result;
    try {
      return JSON.parse(result);
    } catch {
      return { approved: true, feedback: result, gaps: [] };
    }
  },
};
