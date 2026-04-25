# Metrics diff: `baseline-v2` vs `baseline-v1`

- Fixture:      skynet-genesis
- Baseline run: `_kHhoSAPJwW6` (bench/configs/baseline)
- This run:     `0eHpibiVdiCM` (bench/configs/baseline)

| Metric | Baseline | Run | Δ | Verdict |
|---|---:|---:|---:|:---:|
| sources.total | 43 | 72 | +29 (+67.4%) | ✗ worse |
| sources.uniqueNormalized | 43 | 58 | +15 (+34.9%) | · n/a |
| sources.duplicateRatio | 0 | 0.194 | +0.194 | ✗ worse |
| pseudoCitations.count | 0 | 8 | +8 | ✗ worse |
| codeRefs.count | 6 | 9 | +3 (+50.0%) | ✓ better |
| numericClaims.total | 50 | 42 | -8 (-16.0%) | · n/a |
| numericClaims.novel | 6 | 5 | -1 (-16.7%) | ✓ better |
| wallMs | 1994166 | 1217898 | -776268 (-38.9%) | ✓ better |
| totalPromptTokens | 80400 | 82032 | +1632 (+2.0%) | ✗ worse |
| totalCompletionTokens | 36919 | 36980 | +61 (+0.2%) | ✗ worse |
| finalReportTokens | 4524 | 6386 | +1862 (+41.2%) | · n/a |
| workersFailed | 0 | 0 | 0 | = same |

## Round growth

| Round | Baseline in→out (ratio) | Run in→out (ratio) |
|---|---|---|
| round-1 | 20739→17789 (0.86) | 20739→15829 (0.76) |
| round-2 | 17789→13465 (0.76) | 15829→17305 (1.09) |
| final | 13465→4524 (0.34) | 17305→6386 (0.37) |

## Source-list duplicates (this run)

- 4× `https://www.instaclustr.com/education/vector-database/pgvector-performance-benchmark-results-and-5-ways-to-boost-performance`
- 2× `https://c3.ai/blog/meet-charm-c3-ais-foundation-embedding-model-for-time-series`
- 2× `https://github.com/zhihanyue/ts2vec`
- 2× `https://huggingface.co/models?search=cost+time+series`
- 2× `https://github.com/pgvector/pgvector`
- 2× `https://supabase.com/blog/fewer-dimensions-are-better-pgvector`
- 2× `https://medium.com/@bavalpreetsinghh/pgvector-hnsw-vs-ivfflat-a-comprehensive-study-21ce0aaab931`
- 2× `https://neon.com/docs/extensions/pgvector`
- 2× `https://aws.amazon.com/blogs/database/accelerate-hnsw-indexing-and-searching-with-pgvector-on-amazon-aurora-postgresql-compatible-edition-and-amazon-rds-for-postgresql`
- 2× `https://neon.com/blog/dont-use-vector-use-halvec-instead-and-save-50-of-your-storage-cost`

## Novel numeric claims (this run, not in fixture findings)

- `0.54 KB`
- `1.05 KB`
- `11`
- `2.07 KB`
- `4.2`
