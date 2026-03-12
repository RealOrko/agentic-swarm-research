import { execFileSync } from "node:child_process";
import type { ToolHandler } from "../agent-loop.js";

export const grepCodeTool: ToolHandler = {
  definition: {
    type: "function",
    function: {
      name: "grep_code",
      description:
        "Search the codebase for exact text matches. Use this to verify whether a function, variable, type, or string is referenced anywhere. Returns matching lines with file paths and line numbers. The pattern is matched literally (not as regex).",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "Text to search for (e.g. a function name, type name, or string). Matched literally — no regex needed.",
          },
          glob: {
            type: "string",
            description:
              'File glob filter (e.g. "*.c", "*.h", "*.ts"). Omit to search all files.',
          },
          max_results: {
            type: "number",
            description: "Maximum number of matching lines to return (default 30, max 100)",
          },
        },
        required: ["pattern"],
      },
    },
  },

  handler: async (args: Record<string, unknown>): Promise<unknown> => {
    const pattern = args.pattern as string;
    const glob = args.glob as string | undefined;
    const maxResults = Math.min(Math.max((args.max_results as number) || 30, 1), 100);

    try {
      // Escape regex-special characters — treat pattern as a literal string search
      // since LLMs send function names like "foo()" not intending regex
      const safePattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const grepArgs = ["-rn", "--color=never", "--binary-files=without-match"];

      if (glob) {
        grepArgs.push("--include", glob);
      }

      // Exclude common non-source directories and data files
      grepArgs.push(
        "--exclude-dir=node_modules",
        "--exclude-dir=.git",
        "--exclude-dir=dist",
        "--exclude-dir=build",
        "--exclude-dir=vendor",
        "--exclude-dir=data",
        "--exclude=*.db",
        "--exclude=*.db-wal",
        "--exclude=*.db-shm",
      );

      grepArgs.push(safePattern, ".");

      const output = execFileSync("grep", grepArgs, {
        encoding: "utf-8",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });

      const lines = output.split("\n").filter(Boolean);
      const truncated = lines.length > maxResults;
      const resultLines = lines.slice(0, maxResults);

      return {
        pattern,
        glob: glob || "*",
        total_matches: lines.length,
        truncated,
        matches: resultLines,
      };
    } catch (err: unknown) {
      // grep exits with code 1 when no matches found — that's not an error
      if (
        err &&
        typeof err === "object" &&
        "status" in err &&
        (err as { status: number }).status === 1
      ) {
        return {
          pattern,
          glob: glob || "*",
          total_matches: 0,
          truncated: false,
          matches: [],
        };
      }

      return {
        pattern,
        error: err instanceof Error ? err.message : String(err),
        matches: [],
      };
    }
  },
};
