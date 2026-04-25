# Quality Investigation — Handoff

Status as of 2026-04-25. Resume from here.

## What this was

Investigation kicked off by a bad report at `/home/gavin/code/sindarin/skynet-genesis/results/2026-04-23-can-you-research-this-codebase-and-find-out-what-the-best-wa/report.md`. The user wanted to find out why the report was poor and prove measurable improvements per change.

## What's landed and works

### `bench/` — synthesis-replay harness
A measurement framework that lets us replay synthesis on frozen research findings (no LLM cost for research) and compute regex-based defect metrics. Subcommands:

- `bench extract <context.json> <fixture-name>` — turn a real run's `context.json` into a replayable fixture
- `bench replay --fixture <name> --config <dir>` — re-run synthesis on a fixture using the production code path
- `bench metrics <run-dir>` — emit `metrics.json` (sources, pseudo-citations, code refs, numeric novelty, round growth, cost)
- `bench diff <run-dir> <baseline-dir>` — markdown diff between two runs
- `bench measure --fixture --config [--baseline]` — replay → metrics → diff in one shot
- `bench reliability --fixture --config --rate <0..1> --n N` — N trials with injected `spawnWorker` failures, mocks LLM by default

Key files: `bench/src/{extractFixture,replaySynthesis,computeMetrics,diffMetrics,reliability,applyPostprocess,cli}.ts`.

Frozen artifacts:
- `bench/fixtures/skynet-genesis/` — 11 research findings extracted from the bad report's run
- `bench/fixtures/skynet-smoke/` — 4-finding subset for fast tournament tests
- `bench/fixtures/skynet-smoke-2/` — 2-finding subset for fast base-case tests
- `bench/baseline/skynet-genesis/v1/` — clean replay (33.2 min, 0 dups, 0 pseudo-cites)
- `bench/baseline/skynet-genesis/v2/` — same fixture, ran again, 14 dups + 8 pseudo-cites
- `bench/configs/baseline/` — production-equivalent config with bumped `workerTimeoutMs` (20 min vs 5)
- `bench/results/phase-1.0.md` — empirical record of the fault-tolerance fix

### Phase 1.0 — Tournament fault-tolerance (production fix, validated)
`src/synthesis/strategies.ts`:
- `Promise.all` → `Promise.allSettled` in tournament rounds; failed pairs pass through their findings unchanged into the next round
- New `spawnWithRetry` helper wraps the base-case call with 3 attempts, exponential backoff (500ms → 1s → 2s)
- New import: `log` from `../logger.js`

Reliability measured at `p=0.2` and `p=0.4` injected failure rates, n=50, mock-success:

| | p=0.2 | p=0.4 |
|---|---:|---:|
| Before (`Promise.all`) | 42% | 24% |
| After (allSettled + retry×3) | **96%** | **82%** |

Happy path (p=0) unchanged: 100%.

## What's WIP and broken

### Phase 1.1 — Source-list dedup post-processor

`src/synthesis/postprocess.ts` (new) and `src/synthesis/strategies.ts` (`withPostProcess` wrapper in `createSynthesisStrategy`).

**The deterministic dedup logic itself works** — verified offline against frozen baselines:
- v1 (already clean): 43 → 43 sources, 0 dups removed (no-op as expected)
- v2 (had 14 dups): 72 → 58 sources, 14 dups removed, `duplicateRatio` 0.194 → 0.000

**The parser is broken.** End-to-end fresh replay (`bench/runs/2026-04-25T07-49-35-650Z-phase-1.1-v1/`) exposed two issues:

1. **Parser bails on interstitial non-numbered text.** The model emitted bold labels mid-section (`**Finding 2 additional sources**`); the parser hit the first one and stopped collecting items, leaving items 26-72 unprocessed.
2. **The model went into a 26-line URL repetition loop** (items 47-72 are all the same URL). This is a *model* failure mode triggered by big inputs (finding #10's 458 sources rolled up through round-2-pair3). The dedup would have fixed it cosmetically — *if the parser had reached it*.

Net result on that run: 100 sources, 38 unique, dup ratio 0.62. Worse than baseline-v2.

**To fix:** rewrite `dedupeSources` in `src/synthesis/postprocess.ts` to scan the whole section and treat any line not matching `^\d+\.` as skippable. Estimated 10-15 lines changed. Then re-run end-to-end (~25 min) to verify.

## The bigger insight (read this before resuming)

**Hygiene metrics ≠ quality.** Phase 1.1 (source dedup) and the planned 1.3 (pseudo-citation scrub) are *cosmetic*. A report with 0 duplicate sources and 0 pseudo-citations can still be useless boilerplate. The user's actual complaint about the bad report — "the quality is shit" — won't be resolved by deterministic post-processing alone.

Real quality dimensions are:
1. Does the report answer your *specific* question (vs. drifting to the topic generally)?
2. Is it grounded in the codebase you pointed it at (vs. literature review with codebase mentions sprinkled on top)?
3. Are recommendations concrete and actionable for *this* project (vs. "use HNSW, consider quantization" boilerplate)?
4. Does it surface real tradeoffs (vs. one-sided salesmanship)?
5. Does it tell you something you didn't already know?

None of these are regex-detectable. Need either a manual rubric (read + score) or LLM-as-judge.

## Where to resume

Two reasonable next moves, in priority order:

### (1) Pivot to a substance lever, not hygiene

The candidates, ordered by likely impact:

- **Synthesizer prompt rewrite.** Single file (`configs/default-research/prompts/synthesizer.md`). Demand specifics, ban generic best-practice padding, require codebase citations. Iterable in 30-min cycles via the harness. Most direct character-of-output lever.
- **Researcher input-size cap.** Finding #10 dumped 458 sources, which caused the 26-line repetition we saw in Phase 1.1's end-to-end run. Cap per-finding sources at 20 and force the researcher to curate. Affects the worst quality failures.
- **Critique-driven targeted revision.** Currently the critic returns "approved: false + gaps", orchestrator does more research, re-runs the *whole* tournament which smooths everything back out. A "revise this synthesis to address gaps X, Y, Z" prompt would actually close the loop.
- **Orchestrator anti-redundancy.** The original wasted 5 sub-questions on rewordings of "how does dimensionality affect pgvector." Dedupe sub-questions before spawning researchers.

For any of these: add a rubric to the harness (5 binary yes/no questions, manual or LLM-judge) so we can detect *substance* changes, not just hygiene.

### (2) Finish Phase 1.1 as polish (10-min parser fix)

If you want to clear the WIP off the deck before pivoting: rewrite the `dedupeSources` parser to skip non-numbered lines instead of bailing. Re-run end-to-end. Land it. Then move to (1).

I do **not** recommend Phase 1.3 (pseudo-citation scrub) as a follow-on — same hygiene-vs-substance issue.

## How to run the harness

```bash
# Replay synthesis on a fixture (≈ 20-35 min for the full skynet-genesis fixture)
npx tsx bench/src/cli.ts measure --fixture skynet-genesis --config bench/configs/baseline --label some-label --baseline bench/baseline/skynet-genesis/v1

# Just compute metrics on an existing run dir
npx tsx bench/src/cli.ts metrics bench/runs/<dir>

# Reliability test (no LLM calls; mocks spawnWorker success)
npx tsx bench/src/cli.ts reliability --fixture skynet-smoke --config bench/configs/baseline --rate 0.2 --n 50

# Apply the postprocess to a frozen report (offline; no LLM)
npx tsx bench/src/applyPostprocess.ts bench/baseline/skynet-genesis/v2
```

Spark2 (`http://spark2:11434/v1`, model `gpt-oss:120b`) needs to be reachable for any non-mock replay.

## Open questions for resume

1. Manual rubric or LLM-as-judge?
2. Land the Phase 1.1 parser fix and ship it as polish, or revert it?
3. Which substance lever first?
