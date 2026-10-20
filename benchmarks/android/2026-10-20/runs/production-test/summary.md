## Retrieval eval (production)

391 of 392 cases scored, errors: 1; model `Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3@q8@cls`; index built 2026-10-19T09:15:01.164Z; 86.6 s.

All positives: n 282, recall@5 32.6, MRR 0.212.

### By relation

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 69 | 21.7 | 0.123 |
| duplicate | 55 | 52.7 | 0.323 |
| fixed-by | 157 | 29.9 | 0.207 |
| forum | 1 | 100.0 | 1.000 |

### By expected source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 69 | 21.7 | 0.123 |
| forum | 1 | 100.0 | 1.000 |
| issue | 55 | 52.7 | 0.323 |
| pull | 157 | 29.9 | 0.207 |

### By label source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| comment:docs-link | 69 | 21.7 | 0.123 |
| comment:duplicate-of | 37 | 56.8 | 0.353 |
| comment:forum-link | 1 | 100.0 | 1.000 |
| pull:closing-reference | 157 | 29.9 | 0.207 |
| timeline:marked-duplicate | 18 | 44.4 | 0.263 |

### Gate at 0.35

Precision 72.1, specificity 0.0, sensitivity 100.0 over 282 positives and 109 negatives.

| threshold | precision | specificity | sensitivity |
| --- | --- | --- | --- |
| 0.30 | 72.1 | 0.0 | 100.0 |
| 0.35 | 72.1 | 0.0 | 100.0 |
| 0.40 | 72.1 | 0.0 | 100.0 |
| 0.45 | 72.1 | 0.0 | 100.0 |
| 0.50 | 72.1 | 0.0 | 100.0 |
| 0.55 | 72.1 | 0.0 | 100.0 |
| 0.60 | 72.1 | 0.0 | 100.0 |
| 0.65 | 72.1 | 0.0 | 100.0 |
| 0.70 | 72.1 | 0.0 | 100.0 |
| 0.75 | 72.6 | 4.6 | 97.5 |
| 0.80 | 72.9 | 22.0 | 81.2 |
| 0.85 | 75.2 | 76.1 | 28.0 |
| 0.90 | 82.6 | 96.3 | 6.7 |
| 0.95 | 75.0 | 99.1 | 1.1 |
