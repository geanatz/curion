# Recall synthesis concision — POST-STRIP metrics

These metrics are computed AFTER applying the controller's `stripReasoningBlocks`
pass (`<think>...</think>` and leading `Reasoning:` / `Thought:` blocks removed).
This is the length the controller's 800-character cap actually evaluates against.

Primary config for the verdict below: **B** (production target is B; the first config with data is used when B is absent).

## Post-strip metrics per config

| config | n | mean raw chars | mean stripped chars | p95 stripped chars | max stripped chars | mean stripped sentences | max stripped sentences | trimmed to empty | trimmed short (1-10) | stripped >800 | stripped >200 | length finish_reason |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 84 | 368.1 | 368.1 | 860 | 1088 | 2.82 | 8 | 0 | 0 | 8 | 53 | 2 |
| B-fallback | 84 | 1667.8 | 653.9 | 1108 | 1653 | 4.17 | 7 | 0 | 1 | 28 | 78 | 9 |

## Pass/fail verdict (config B — POST-STRIP)

- **FAIL** — zero finish_reason=length under B: 2 truncations
- **FAIL** — p95 stripped chars <= 750 under B: p95 = 860 stripped chars
- **FAIL** — max stripped chars <= 1000 under B: max = 1088 stripped chars
- **FAIL** — >=95% of B answers <= 3 sentences (stripped): 65.5% short
- **FAIL** — zero stripped answers > 800 chars under B: 8 would still hit the 800 cap

## Per-family post-strip metrics (config B)

| family | n | mean stripped chars | p95 stripped chars | max stripped chars |
|---|---|---|---|---|
| orientation | 26 | 472.0 | 965 | 1088 |
| no-answer | 16 | 57.6 | 111 | 322 |
| paraphrase | 12 | 426.3 | 723 | 843 |
| temporal | 10 | 364.4 | 664 | 824 |
| multi-hop | 10 | 675.4 | 1024 | 1064 |
| exact | 10 | 221.3 | 395 | 396 |

## Top 5 longest stripped answers (config B)

- orient-provider-routing-status (orientation, raw=1088 chars, stripped=1088 chars, sentences=6)
  preview: The provider adapter first attempts the request against the primary service. If the primary responds…
- multi-bridge-stdio-and-stderr (multi-hop, raw=1064 chars, stripped=1064 chars, sentences=6)
  preview: The Model Context Protocol (MCP) stdio transport uses a single stdin/stdout pair to multiplex every …
- orient-current-vs-previous-status (orientation, raw=1012 chars, stripped=1012 chars, sentences=5)
  preview: The corpus today records a current‑vs‑previous comparison for the primary data store: the current st…
- multi-deps-policy (multi-hop, raw=975 chars, stripped=975 chars, sentences=8)
  preview: Direct dependencies in the project are pinned to an exact version range, meaning each entry in packa…
- multi-bridge-rate-limit-and-retry (multi-hop, raw=863 chars, stripped=863 chars, sentences=5)
  preview: The provider’s request flow is governed by a rate‑limit that is read from the environment variable C…

## Top 5 shortest stripped answers (config B, non-empty)

- orient-ci-extensions-status (orientation, raw=40 chars, stripped=40 chars, sentences=1)
  preview: I don't have that information in memory.…
- orient-conflict-status (orientation, raw=40 chars, stripped=40 chars, sentences=1)
  preview: I don't have that information in memory.…
- orient-monitoring-status (orientation, raw=40 chars, stripped=40 chars, sentences=1)
  preview: I don't have that information in memory.…
- orient-multi-hop-bridge-status (orientation, raw=40 chars, stripped=40 chars, sentences=1)
  preview: I don't have that information in memory.…
- orient-security-status (orientation, raw=40 chars, stripped=40 chars, sentences=1)
  preview: I don't have that information in memory.…

## Model-swap side-by-side — POST-STRIP (B primary vs B-fallback, both new prompt + max_tokens=512)

B = new default primary (`openai/gpt-oss-120b`); B-fallback = new fallback (`MiniMax-M3`).
These are the char counts the user actually sees on the wire (after reasoning-block stripping).

### Aggregate metrics (POST-STRIP)

| metric | B | B-fallback |
|---|---|---|
| n queries | 84 | 84 |
| mean stripped chars | 368.1 | 653.9 |
| median stripped chars | 316 | 662 |
| p50 stripped chars | 316 | 662 |
| p75 stripped chars | 560 | 868 |
| p90 stripped chars | 753 | 1031 |
| p95 stripped chars | 860 | 1108 |
| p99 stripped chars | 1068 | 1408 |
| max stripped chars | 1088 | 1653 |
| mean sentences | 2.82 | 4.17 |
| max sentences | 8 | 7 |
| finish_reason=length | 2 | 9 |

### Threshold-crossing distribution — POST-STRIP char counts

| threshold | B (count / %) | B-fallback (count / %) |
|---|---|---|
| <= 400 chars | 48 / 57.1% | 21 / 25.0% |
| <= 800 chars | 76 / 90.5% | 56 / 66.7% |
| <= 1000 chars | 81 / 96.4% | 74 / 88.1% |
| <= 1200 chars | 84 / 100.0% | 81 / 96.4% |
| <= 1500 chars | 84 / 100.0% | 83 / 98.8% |
| > 1500 chars | 0 / 0.0% | 1 / 1.2% |

User's expectations: typical target ~800 chars; 900-1200 chars is OK; <70% over 800 chars; no consistent 1500+ chars.
On stripped chars: B has 9.5% over 800, B-fallback has 33.3% over 800.