// Tournament synthesis strategy — pairwise merging rounds
// This is an example of an external strategy. The default research swarm
// uses the built-in tournament strategy, but this file shows how to
// externalize it as a config package plugin.

function pairUp(items) {
  const pairs = [];
  for (let i = 0; i < items.length; i += 2) {
    if (i + 1 < items.length) {
      pairs.push([items[i], items[i + 1]]);
    } else {
      pairs.push([items[i]]);
    }
  }
  return pairs;
}

function formatFindings(findings, goal) {
  const findingsText = findings
    .map(
      (f, i) =>
        `## Finding ${i + 1}: ${f.question}\n\n${f.answer}\n\nSources: ${f.sources.join(", ")}`,
    )
    .join("\n\n---\n\n");

  return `Original goal: ${goal}\n\nResearch findings:\n\n${findingsText}`;
}

async function tournamentRound(goal, findings, ctx, agentFactory, depth, maxDepth, baseCaseSize) {
  if (findings.length <= baseCaseSize || depth >= maxDepth) {
    const workerResult = await agentFactory.spawnWorker(
      "synthesizer",
      formatFindings(findings, goal),
      ctx,
      { name: "synthesizer" },
    );
    return workerResult.result;
  }

  const pairs = pairUp(findings);
  const intermediates = await Promise.all(
    pairs.map(async (pair, i) => {
      const pairLabel = `round-${depth + 1}-pair${i + 1}`;
      const workerResult = await agentFactory.spawnWorker(
        "synthesizer",
        formatFindings(pair, goal),
        ctx,
        { name: `synthesizer-${pairLabel}` },
      );
      const allSources = pair.flatMap((f) => f.sources);
      return {
        question: `Intermediate synthesis (${pairLabel})`,
        answer: workerResult.result,
        sources: [...new Set(allSources)],
      };
    }),
  );

  return tournamentRound(goal, intermediates, ctx, agentFactory, depth + 1, maxDepth, baseCaseSize);
}

export async function synthesize(goal, findings, ctx, agentFactory) {
  return tournamentRound(goal, findings, ctx, agentFactory, 0, 3, 3);
}
