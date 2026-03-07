import { runResearch } from "./orchestrator.js";
import { logRaw, logError, closeLogger } from "./logger.js";

// Parse --repo flag
const args = process.argv.slice(2);
let repoPath: string | undefined;
const remaining: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--repo" && i + 1 < args.length) {
    repoPath = args[i + 1];
    i++; // skip next arg
  } else {
    remaining.push(args[i]);
  }
}

const goal = remaining.join(" ");

if (!goal) {
  console.error(
    'Usage: npm run research -- [--repo /path/to/codebase] "<your research question>"'
  );
  process.exit(1);
}

try {
  const ctx = await runResearch(goal, repoPath);

  const eventCounts = ctx.events.reduce(
    (acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  logRaw("");
  logRaw("  Execution summary:");
  logRaw(`   Events: ${ctx.events.length} total`);
  for (const [type, count] of Object.entries(eventCounts)) {
    logRaw(`   - ${type}: ${count}`);
  }
  await closeLogger();
} catch (err) {
  logError("system", `Research failed: ${err}`);
  await closeLogger();
  process.exit(1);
}
