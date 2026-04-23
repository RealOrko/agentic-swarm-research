import fs from "node:fs";
import path from "node:path";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";
import { addNode, getRootId } from "../context.js";

export interface ReadFileToolConfig {
  basePath: string;
  maxLines: number;
  maxBytes: number;
}

function resolveWithinBase(basePath: string, relPath: string): string | null {
  const resolved = path.resolve(basePath, relPath);
  const baseResolved = path.resolve(basePath);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
    return null;
  }
  return resolved;
}

export function createReadFileTool(config: ReadFileToolConfig): ToolHandler {
  return {
    definition: {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a file from the indexed codebase by path. Use this to inspect the exact contents of a file the user named or that you found via grep_code / search_code / list_files. Returns file contents with 1-indexed line numbers. Paths are relative to the indexed codebase root and cannot escape it.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Path to the file, relative to the indexed codebase root (e.g. 'src/main.py', 'normal.py').",
            },
            start_line: {
              type: "number",
              description: "Optional 1-indexed start line (inclusive). Defaults to 1.",
            },
            end_line: {
              type: "number",
              description:
                "Optional 1-indexed end line (inclusive). Defaults to start_line + maxLines - 1.",
            },
          },
          required: ["path"],
        },
      },
    },

    handler: async (args: Record<string, unknown>, ctx: Context): Promise<unknown> => {
      const relPath = args.path as string;
      const startArg = args.start_line as number | undefined;
      const endArg = args.end_line as number | undefined;

      if (!config.basePath) {
        return {
          path: relPath,
          error:
            "read_file is unavailable — no codebase basePath is configured. Run with --codebase <path> to enable.",
          content: "",
        };
      }

      const absPath = resolveWithinBase(config.basePath, relPath);
      if (!absPath) {
        return {
          path: relPath,
          error: `Path escapes codebase root: ${relPath}`,
          content: "",
        };
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(absPath);
      } catch (err) {
        return {
          path: relPath,
          error: err instanceof Error ? err.message : String(err),
          content: "",
        };
      }

      if (!stat.isFile()) {
        return { path: relPath, error: "Not a regular file", content: "" };
      }

      if (stat.size > config.maxBytes * 8) {
        return {
          path: relPath,
          error: `File too large (${stat.size} bytes). Use start_line/end_line to read a range.`,
          content: "",
        };
      }

      let raw: string;
      try {
        raw = fs.readFileSync(absPath, "utf-8");
      } catch (err) {
        return {
          path: relPath,
          error: err instanceof Error ? err.message : String(err),
          content: "",
        };
      }

      const lines = raw.split("\n");
      const totalLines = lines.length;
      const start = Math.max(1, startArg ?? 1);
      const requestedEnd = endArg ?? start + config.maxLines - 1;
      const cappedEnd = Math.min(totalLines, start + config.maxLines - 1, requestedEnd);

      const selected = lines.slice(start - 1, cappedEnd);
      const truncated = cappedEnd < totalLines || (endArg !== undefined && endArg > cappedEnd);

      const numberedLines = selected.map((line, i) => {
        const lineNum = start + i;
        return `${String(lineNum).padStart(5, " ")}  ${line}`;
      });
      let content = numberedLines.join("\n");

      if (content.length > config.maxBytes) {
        content = content.slice(0, config.maxBytes) + "\n[...truncated — file exceeds max bytes]";
      }

      const node = addNode(ctx, {
        type: "file_content",
        parentId: getRootId(ctx),
        content,
        source: "read_file",
        summary: `read_file ${relPath} (${start}-${cappedEnd} of ${totalLines})`,
        metadata: { path: relPath, startLine: start, endLine: cappedEnd, totalLines, truncated },
      });

      return {
        path: relPath,
        start_line: start,
        end_line: cappedEnd,
        total_lines: totalLines,
        truncated,
        content,
        _nodeId: node.id,
      };
    },
  };
}
