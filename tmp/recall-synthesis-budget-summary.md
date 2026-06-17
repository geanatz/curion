# Recall synthesis concision — budget probe summary (relaxed-prompt run)

Generated: 2026-06-17T19:15:11.594Z

## Setup

- Primary provider: `openai/gpt-oss-120b` (NVIDIA NIM, OpenAI-compatible)
- Fallback provider: `MiniMax-M3` (MiniMax, OpenAI-compatible)
- Query selection: 84 queries total (26 orientation + 16 no-answer + 12 paraphrase + 10 temporal + 10 multi-hop + 10 exact)
- Retrieval: lexical ranker, top-5, threshold 0.2
- Filter: BUDGETS=512 (new-prompt only; A skipped)
- 14 rate-limited B records retried with backoff (success: 14/14; one came back as `finish=length`)

## Per-config metrics (this run, BUDGETS=512)

| config | n | ok | mean raw chars | p95 raw chars | max raw chars | mean sentences | max sentences | length truncations | errors |
|---|---|---|---|---|---|---|---|---|---|
| B | 84 | 84 | 368.1 | 860 | 1088 | 2.82 | 8 | 2 | 0 |
| B-fallback | 84 | 84 | 1667.8 | 2605 | 2739 | 13.50 | 25 | 9 | 0 |

## Finish-reason distribution (this run)

- **B**: {"stop":82,"length":2}
- **B-fallback**: {"stop":75,"length":9}

## Per-family char-count mean (config B, this run)

| family | n | mean raw chars | p95 raw chars | max raw chars |
|---|---|---|---|---|
| orientation | 26 | 472.0 | 965 | 1088 |
| no-answer | 16 | 57.6 | 111 | 322 |
| paraphrase | 12 | 426.3 | 723 | 843 |
| temporal | 10 | 364.4 | 664 | 824 |
| multi-hop | 10 | 675.4 | 1024 | 1064 |
| exact | 10 | 221.3 | 395 | 396 |

## Comparison to previous run — relaxed-prompt vs restrictive-prompt (this run vs previous JSONL)

| config | n (prev) | n (this) | mean chars (prev → this) | p95 chars (prev → this) | max chars (prev → this) | length trunc (prev → this) |
|---|---|---|---|---|---|---|
| B | 84 | 84 | 146.0 → 368.1 | 357 → 860 | 453 → 1088 | 0 → 2 |
| B-fallback | 84 | 84 | 818.1 → 1667.8 | 1606 → 2605 | 2417 → 2739 | 1 → 9 |

## Model-swap side-by-side (B primary vs B-fallback, both new relaxed prompt + max_tokens=512)

B = primary (`openai/gpt-oss-120b`); B-fallback = fallback (`MiniMax-M3`).

### Aggregate metrics (raw char counts)

| metric | B | B-fallback |
|---|---|---|
| n queries | 84 | 84 |
| mean raw chars | 368.1 | 1667.8 |
| median raw chars | 316 | 1640 |
| p50 raw chars | 316 | 1640 |
| p75 raw chars | 560 | 2218 |
| p90 raw chars | 753 | 2427 |
| p95 raw chars | 860 | 2605 |
| p99 raw chars | 1068 | 2711 |
| max raw chars | 1088 | 2739 |
| mean sentences | 2.82 | 13.50 |
| max sentences | 8 | 25 |
| finish_reason=length | 2 | 9 |

### Per-family breakdown (raw chars)

| family | n (B) | mean B | p95 B | max B | finish=length B | n (Bf) | mean Bf | p95 Bf | max Bf | finish=length Bf |
|---|---|---|---|---|---|---|---|---|---|---|
| orientation | 26 | 472.0 | 965 | 1088 | 1 | 26 | 1975.8 | 2638 | 2705 | 5 |
| no-answer | 16 | 57.6 | 111 | 322 | 0 | 16 | 1099.9 | 1653 | 2332 | 0 |
| paraphrase | 12 | 426.3 | 723 | 843 | 0 | 12 | 1664.6 | 2335 | 2354 | 1 |
| temporal | 10 | 364.4 | 664 | 824 | 0 | 10 | 1715.8 | 2509 | 2739 | 1 |
| multi-hop | 10 | 675.4 | 1024 | 1064 | 1 | 10 | 2070.1 | 2621 | 2646 | 2 |
| exact | 10 | 221.3 | 395 | 396 | 0 | 10 | 1329.4 | 1928 | 1941 | 0 |

### Threshold-crossing distribution — RAW char counts

| threshold | B (count / %) | B-fallback (count / %) |
|---|---|---|
| <= 200 chars | 31 / 36.9% | 0 / 0.0% |
| <= 400 chars | 48 / 57.1% | 1 / 1.2% |
| <= 600 chars | 64 / 76.2% | 5 / 6.0% |
| <= 800 chars | 76 / 90.5% | 7 / 8.3% |
| <= 1000 chars | 81 / 96.4% | 10 / 11.9% |
| <= 1200 chars | 84 / 100.0% | 19 / 22.6% |
| <= 1500 chars | 84 / 100.0% | 34 / 40.5% |
| > 1500 chars | 0 / 0.0% | 50 / 59.5% |

User's expectations: typical target ~800 chars; 900-1200 chars is OK; <70% over 800 chars; no consistent 1500+ chars.
On raw chars: B has 9.5% over 800, B-fallback has 91.7% over 800.

### Top 5 longest raw answers (config B)

- orient-provider-routing-status (orientation, 1088 chars, 6 sentences, finish=stop)
  Q: How does the provider adapter route and retry today?
  A: The provider adapter first attempts the request against the primary service. If the primary responds with a 429 (rate‑limit) or any 5xx error, the adapter immediately falls back to the secondary service and the outcome is returned as a typed result union. For 429 responses the adapter retries the call using exponential back‑off: it waits one second before the first retry, two seconds before the se…

- multi-bridge-stdio-and-stderr (multi-hop, 1064 chars, 6 sentences, finish=stop)
  Q: How do the stdio transport and the stderr-only logging fit together?
  A: The Model Context Protocol (MCP) stdio transport uses a single stdin/stdout pair to multiplex every request and response, and it is the only transport that is supported while the SDK remains pinned to the 1.x major version. Because the protocol frames occupy the entire stdout stream, the implementation guarantees that nothing else ever writes to stdout; all application‑level logging is forced to t…

- orient-current-vs-previous-status (orientation, 1012 chars, 5 sentences, finish=stop)
  Q: What current-vs-previous pairs are in the corpus today?
  A: The corpus today records a current‑vs‑previous comparison for the primary data store: the current store is Postgres 16 with logical replication to a warm standby, whereas the previous store was Postgres 14 with a single hot standby. It also captures the release‑cut process: the current cut is taken from the main branch on Tuesdays, while the previous cut was made from a release branch on Thursdays…

- multi-deps-policy (multi-hop, 975 chars, 8 sentences, finish=stop)
  Q: How are dependencies pinned, reviewed, and upgraded?
  A: Direct dependencies in the project are pinned to an exact version range, meaning each entry in package.json specifies a concrete version rather than a caret or tilde range. The repository uses npm with a checked‑in package‑lock.json, and any lockfiles from other package managers such as Yarn or pnpm are rejected in pull requests.    Transitive (indirect) dependency upgrades are not applied automat…

- multi-bridge-rate-limit-and-retry (multi-hop, 863 chars, 5 sentences, finish=stop)
  Q: How does the rate-limit policy and the exponential-backoff retry on 429 fit together?
  A: The provider’s request flow is governed by a rate‑limit that is read from the environment variable CURION_PROVIDER_RATE_LIMIT; if the variable is not set the limit defaults to sixty requests per minute and is applied separately for each environment. When a request exceeds that limit the provider returns an HTTP 429 response. The provider adapter catches a 429 and automatically retries the request …
