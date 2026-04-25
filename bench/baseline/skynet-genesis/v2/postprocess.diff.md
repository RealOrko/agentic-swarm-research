# Metrics diff: `baseline-v2` vs `baseline-v2`

- Fixture:      skynet-genesis
- Baseline run: `0eHpibiVdiCM` (bench/configs/baseline)
- This run:     `0eHpibiVdiCM` (bench/configs/baseline)

| Metric | Baseline | Run | Δ | Verdict |
|---|---:|---:|---:|:---:|
| sources.total | 72 | 58 | -14 (-19.4%) | ✓ better |
| sources.uniqueNormalized | 58 | 58 | 0 (0.0%) | = same |
| sources.duplicateRatio | 0.194 | 0 | -0.194 (-100.0%) | ✓ better |
| pseudoCitations.count | 8 | 8 | 0 (0.0%) | = same |
| codeRefs.count | 9 | 9 | 0 (0.0%) | = same |
| numericClaims.total | 42 | 42 | 0 (0.0%) | = same |
| numericClaims.novel | 5 | 5 | 0 (0.0%) | = same |
| wallMs | 1217898 | 1217898 | 0 (0.0%) | = same |
| totalPromptTokens | 82032 | 82032 | 0 (0.0%) | = same |
| totalCompletionTokens | 36980 | 36980 | 0 (0.0%) | = same |
| finalReportTokens | 6386 | 6386 | 0 (0.0%) | = same |
| workersFailed | 0 | 0 | 0 | = same |

## Round growth

| Round | Baseline in→out (ratio) | Run in→out (ratio) |
|---|---|---|
| round-1 | 20739→15829 (0.76) | 20739→15829 (0.76) |
| round-2 | 15829→17305 (1.09) | 15829→17305 (1.09) |
| final | 17305→6386 (0.37) | 17305→6386 (0.37) |

## Novel numeric claims (this run, not in fixture findings)

- `0.54 KB`
- `1.05 KB`
- `11`
- `2.07 KB`
- `4.2`
