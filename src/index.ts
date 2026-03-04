import { runResearch } from "./orchestrator.js";

const goal = process.argv.slice(2).join(" ");

if (!goal) {
  console.error("Usage: npm run research -- \"<your research question>\"");
  process.exit(1);
}

try {
  const ctx = await runResearch(goal);

  const eventCounts = ctx.events.reduce(
    (acc, e) => {
      acc[e.type] = (acc[e.type] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  console.log("\n📊 Execution summary:");
  console.log(`   Events: ${ctx.events.length} total`);
  for (const [type, count] of Object.entries(eventCounts)) {
    console.log(`   - ${type}: ${count}`);
  }
} catch (err) {
  console.error("Research failed:", err);
  process.exit(1);
}
