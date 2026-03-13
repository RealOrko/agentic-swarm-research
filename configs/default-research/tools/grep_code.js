// Grep code tool — literal text search over the codebase
export const schema = {
  type: "function",
  function: {
    name: "grep_code",
    description:
      "Search the codebase for exact text matches. Returns matching lines with file paths and line numbers. The pattern is matched literally (not as regex).",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Text to search for (matched literally — no regex needed).",
        },
        glob: {
          type: "string",
          description: 'File glob filter (e.g. "*.c", "*.ts"). Omit to search all files.',
        },
        max_results: {
          type: "number",
          description: "Maximum number of matching lines to return (default 30, max 100)",
        },
      },
      required: ["pattern"],
    },
  },
};

export async function handler(args, ctx) {
  const pattern = args.pattern;
  const glob = args.glob;
  const maxResults = Math.min(
    Math.max(args.max_results || ctx.config.maxResults || 30, 1),
    ctx.config.maxResultsCap || 100,
  );

  try {
    const safePattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const grepArgs = ["-rn", "--color=never", "--binary-files=without-match"];
    if (glob) grepArgs.push("--include", glob);

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

    const output = ctx.exec("grep", grepArgs, {
      encoding: "utf-8",
      timeout: ctx.config.timeoutMs || 15000,
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
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && err.status === 1) {
      return { pattern, glob: glob || "*", total_matches: 0, truncated: false, matches: [] };
    }
    return { pattern, error: err.message || String(err), matches: [] };
  }
}
