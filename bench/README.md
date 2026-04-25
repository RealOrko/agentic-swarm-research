# bench/

Empirical-iteration harness for measuring report-quality changes without re-running the full research pipeline.

The expensive part of an end-to-end run is research (web search + code reads). The buggy part is mostly synthesis. So we freeze research output as **fixtures** and replay them through synthesis variants — turning a multi-minute end-to-end run into a sub-minute fixture replay.

## Layout

```
bench/
  fixtures/<name>/        # frozen research output (goal + findings)
  baseline/<name>/        # frozen current-pipeline outputs (report + trace + metrics)
  configs/<variant>.yaml  # synthesis configs to A/B test
  runs/<ts>-<config>/     # outputs from one replay (gitignored)
  src/                    # extractFixture, replaySynthesis, computeMetrics, diffMetrics, cli
```

## Cycle

```
# (one-time per fixture) extract from a real run's context.json
tsx bench/src/extractFixture.ts <path-to-context.json> <fixture-name>

# iterate on a synthesis variant
tsx bench/src/replaySynthesis.ts --fixture skynet-genesis --config baseline
tsx bench/src/computeMetrics.ts <run-dir>
tsx bench/src/diffMetrics.ts <run-dir> bench/baseline/skynet-genesis
```

Phase 0 builds the harness incrementally — each script lands behind explicit approval.
