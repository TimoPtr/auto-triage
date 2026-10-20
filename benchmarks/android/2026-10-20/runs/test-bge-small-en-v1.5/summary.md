## Retrieval eval (production)

391 of 392 cases scored, errors: 1; model `Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3@q8@cls`; index built 2026-10-20T10:02:43.105Z; 89.7 s.

All positives: n 282, recall@5 33.0, MRR 0.212.

### By relation

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 69 | 21.7 | 0.123 |
| duplicate | 55 | 52.7 | 0.333 |
| fixed-by | 157 | 30.6 | 0.204 |
| forum | 1 | 100.0 | 1.000 |

### By expected source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 69 | 21.7 | 0.123 |
| forum | 1 | 100.0 | 1.000 |
| issue | 55 | 52.7 | 0.333 |
| pull | 157 | 30.6 | 0.204 |

### By label source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| comment:docs-link | 69 | 21.7 | 0.123 |
| comment:duplicate-of | 37 | 56.8 | 0.368 |
| comment:forum-link | 1 | 100.0 | 1.000 |
| pull:closing-reference | 157 | 30.6 | 0.204 |
| timeline:marked-duplicate | 18 | 44.4 | 0.260 |

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
| 0.75 | 72.4 | 3.7 | 97.9 |
| 0.80 | 72.8 | 22.0 | 80.9 |
| 0.85 | 76.5 | 78.0 | 27.7 |
| 0.90 | 86.4 | 97.2 | 6.7 |
| 0.95 | 75.0 | 99.1 | 1.1 |
