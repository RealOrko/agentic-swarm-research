import fs from "node:fs";
import path from "node:path";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";
import { addNode, getRootId } from "../context.js";

export interface ListFilesToolConfig {
  basePath: string;
  maxResults: number;
  maxResultsCap: number;
  excludeDirs: string[];
}

function resolveWithinBase(basePath: string, relPath: string): string | null {
  const resolved = path.resolve(basePath, relPath);
  const baseResolved = path.resolve(basePath);
  if (resolved !== baseResolved && !resolved.startsWith(baseResolved + path.sep)) {
    return null;
  }
  return resolved;
}

/** Convert a simple glob (supporting *, **, ?) into a RegExp. */
function globToRegex(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (glob[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (".+^$()|{}[]\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

function walk(
  dir: string,
  baseAbs: string,
  excludeDirs: Set<string>,
  matcher: ((rel: string) => boolean) | null,
  limit: number,
  out: string[],
): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(baseAbs, full);
    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name)) continue;
      if (!walk(full, baseAbs, excludeDirs, matcher, limit, out)) return false;
    } else if (entry.isFile()) {
      if (matcher && !matcher(rel)) continue;
      out.push(rel);
      if (out.length >= limit) return false;
    }
  }
  return true;
}

export function createListFilesTool(config: ListFilesToolConfig): ToolHandler {
  return {
    definition: {
      type: "function",
      function: {
        name: "list_files",
        description:
          "List files in the indexed codebase, optionally filtered by a glob pattern and/or scoped to a sub-directory. Use this to discover file paths before reading them with read_file, or to confirm a file exists before grepping. Paths returned are relative to the codebase root.",
        parameters: {
          type: "object",
          properties: {
            glob: {
              type: "string",
              description:
                "Optional glob pattern matched against the relative path (e.g. '**/*.py', 'src/**/*.ts', 'normal.py'). Omit to list all files.",
            },
            directory: {
              type: "string",
              description:
                "Optional sub-directory to scope the listing to, relative to the codebase root. Defaults to the codebase root.",
            },
            max_results: {
              type: "number",
              description: "Maximum number of paths to return (default 100, max 500).",
            },
          },
          required: [],
        },
      },
    },

    handler: async (args: Record<string, unknown>, ctx: Context): Promise<unknown> => {
      const glob = args.glob as string | undefined;
      const directory = (args.directory as string | undefined) ?? "";
      const requestedMax = Math.min(
        Math.max((args.max_results as number) || config.maxResults, 1),
        config.maxResultsCap,
      );

      if (!config.basePath) {
        return {
          error:
            "list_files is unavailable — no codebase basePath is configured. Run with --codebase <path> to enable.",
          files: [],
        };
      }

      const baseAbs = path.resolve(config.basePath);
      const scanRoot = resolveWithinBase(config.basePath, directory);
      if (!scanRoot) {
        return { error: `Directory escapes codebase root: ${directory}`, files: [] };
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(scanRoot);
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
          files: [],
        };
      }
      if (!stat.isDirectory()) {
        return { error: `Not a directory: ${directory}`, files: [] };
      }

      const matcher = glob ? (rel: string) => globToRegex(glob).test(rel) : null;
      const excludeSet = new Set(config.excludeDirs);

      const found: string[] = [];
      const limit = requestedMax + 1;
      walk(scanRoot, baseAbs, excludeSet, matcher, limit, found);
      const truncated = found.length > requestedMax;
      const results = found.slice(0, requestedMax).sort();

      const node = addNode(ctx, {
        type: "search_result",
        parentId: getRootId(ctx),
        content: results.join("\n"),
        source: "list_files",
        summary: `list_files${glob ? ` glob="${glob}"` : ""}${
          directory ? ` dir="${directory}"` : ""
        } → ${results.length} file${results.length === 1 ? "" : "s"}${truncated ? " (truncated)" : ""}`,
        metadata: { glob: glob || "*", directory: directory || ".", matches: results.length, truncated },
      });

      return {
        glob: glob || "*",
        directory: directory || ".",
        total_matches: results.length,
        truncated,
        files: results,
        _nodeId: node.id,
      };
    },
  };
}
