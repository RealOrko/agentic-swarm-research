import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { ToolHandler } from "../agent-loop.js";
import type { Context } from "../context.js";
import { addNode } from "../context.js";

function safePath(repoPath: string, filePath: string): string | null {
  const resolved = path.resolve(repoPath, filePath);
  if (!resolved.startsWith(path.resolve(repoPath))) {
    return null;
  }
  return resolved;
}

export function createListFilesTool(repoPath: string): ToolHandler {
  return {
    definition: {
      type: "function",
      function: {
        name: "list_files",
        description:
          "List files in the repository matching a glob pattern. Returns file paths relative to the repo root.",
        parameters: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description:
                'Glob pattern to match files (e.g. "**/*.ts", "src/**/*.go", "*.json")',
            },
          },
          required: ["pattern"],
        },
      },
    },

    handler: async (args: Record<string, unknown>): Promise<unknown> => {
      const pattern = args.pattern as string;

      try {
        // Use find with basic glob support, or git ls-files if it's a git repo
        let files: string[];
        const isGit = fs.existsSync(path.join(repoPath, ".git"));

        if (isGit) {
          const output = execSync(`git ls-files -- '${pattern}'`, {
            cwd: repoPath,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          files = output.trim().split("\n").filter(Boolean);
        } else {
          // Fallback to find
          const output = execSync(
            `find . -path './${pattern}' -type f 2>/dev/null | head -100`,
            {
              cwd: repoPath,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            }
          );
          files = output
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((f) => f.replace(/^\.\//, ""));
        }

        return { pattern, files: files.slice(0, 100), total: files.length };
      } catch (err) {
        return {
          pattern,
          error: err instanceof Error ? err.message : String(err),
          files: [],
        };
      }
    },
  };
}

export function createReadFileTool(repoPath: string): ToolHandler {
  return {
    definition: {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read the contents of a file in the repository. Returns the file content with line numbers.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "File path relative to the repo root (e.g. 'src/main.ts')",
            },
            max_lines: {
              type: "number",
              description:
                "Maximum number of lines to read (default 200). Use for large files.",
            },
          },
          required: ["path"],
        },
      },
    },

    handler: async (args: Record<string, unknown>, ctx: Context): Promise<unknown> => {
      const filePath = args.path as string;
      const maxLines = (args.max_lines as number) || 200;
      const parentNodeId = (args._parentNodeId as string) || ctx.tree.rootId;

      const resolved = safePath(repoPath, filePath);
      if (!resolved) {
        return { path: filePath, error: "Path is outside the repository" };
      }

      try {
        const content = fs.readFileSync(resolved, "utf-8");
        const lines = content.split("\n");
        const truncated = lines.length > maxLines;
        const displayLines = lines.slice(0, maxLines);

        const numbered = displayLines
          .map((line, i) => `${String(i + 1).padStart(4)}  ${line}`)
          .join("\n");

        // Create tree nodes for file content
        const fileNode = addNode(ctx, {
          type: "file_content",
          parentId: parentNodeId,
          content: numbered,
          source: filePath,
          summary: `File ${filePath} (${lines.length} lines)`,
          metadata: { totalLines: lines.length, truncated },
        });

        // If file is large, create chunk children for granular compaction
        if (displayLines.length > 100) {
          const chunkSize = 80;
          for (let start = 0; start < displayLines.length; start += chunkSize) {
            const chunkLines = displayLines.slice(start, start + chunkSize);
            const chunkContent = chunkLines
              .map((line, i) => `${String(start + i + 1).padStart(4)}  ${line}`)
              .join("\n");
            addNode(ctx, {
              type: "chunk",
              parentId: fileNode.id,
              content: chunkContent,
              source: filePath,
              summary: `${filePath} lines ${start + 1}-${Math.min(start + chunkSize, displayLines.length)}`,
            });
          }
        }

        // Auto-index into knowledge store
        if (ctx.knowledgeStore) {
          ctx.knowledgeStore
            .index(content, "code", filePath, {
              lines: `1-${lines.length}`,
            })
            .catch(() => {});
        }

        return {
          path: filePath,
          content: numbered,
          totalLines: lines.length,
          truncated,
          _nodeId: fileNode.id,
        };
      } catch (err) {
        return {
          path: filePath,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export function createGrepCodeTool(repoPath: string): ToolHandler {
  return {
    definition: {
      type: "function",
      function: {
        name: "grep_code",
        description:
          "Search for a pattern across files in the repository. Returns matching lines with file paths and line numbers.",
        parameters: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Regular expression pattern to search for",
            },
            glob: {
              type: "string",
              description:
                'Optional file glob to limit search scope (e.g. "*.ts", "src/**/*.go")',
            },
          },
          required: ["pattern"],
        },
      },
    },

    handler: async (args: Record<string, unknown>, ctx: Context): Promise<unknown> => {
      const pattern = args.pattern as string;
      const glob = args.glob as string | undefined;

      try {
        let cmd = `grep -rn --include='*' -E '${pattern.replace(/'/g, "'\\''")}'`;
        if (glob) {
          cmd = `grep -rn --include='${glob}' -E '${pattern.replace(/'/g, "'\\''")}'`;
        }
        cmd += " . 2>/dev/null | head -50";

        const output = execSync(cmd, {
          cwd: repoPath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });

        const matches = output
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const match = line.match(/^\.\/(.+?):(\d+):(.*)$/);
            if (match) {
              return {
                file: match[1],
                line: parseInt(match[2]),
                content: match[3].trim(),
              };
            }
            return { file: "", line: 0, content: line };
          });

        // Auto-index grep matches into knowledge store
        if (ctx.knowledgeStore && matches.length > 0) {
          const byFile = new Map<string, string[]>();
          for (const m of matches) {
            if (!m.file) continue;
            const arr = byFile.get(m.file) || [];
            arr.push(`${m.line}: ${m.content}`);
            byFile.set(m.file, arr);
          }
          for (const [file, lines] of byFile) {
            ctx.knowledgeStore
              .index(lines.join("\n"), "grep_match", file, { pattern })
              .catch(() => {});
          }
        }

        return { pattern, glob: glob || "*", matches };
      } catch (err) {
        // grep returns exit code 1 when no matches found
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("exit code 1")) {
          return { pattern, glob: glob || "*", matches: [] };
        }
        return {
          pattern,
          error: msg,
          matches: [],
        };
      }
    },
  };
}
