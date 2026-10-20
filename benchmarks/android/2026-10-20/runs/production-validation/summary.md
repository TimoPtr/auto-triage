## Retrieval eval (production)

383 of 385 cases scored, errors: 2; model `Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3@q8@cls`; index built 2026-10-19T09:15:01.164Z; 79.9 s.

All positives: n 255, recall@5 30.6, MRR 0.213.

### By relation

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 53 | 13.2 | 0.100 |
| duplicate | 49 | 57.1 | 0.435 |
| fixed-by | 153 | 28.1 | 0.181 |

### By expected source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 53 | 13.2 | 0.100 |
| issue | 48 | 58.3 | 0.444 |
| pull | 154 | 27.9 | 0.180 |

### By label source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| comment:docs-link | 53 | 13.2 | 0.100 |
| comment:duplicate-of | 37 | 59.5 | 0.421 |
| pull:closing-reference | 153 | 28.1 | 0.181 |
| timeline:marked-duplicate | 12 | 50.0 | 0.478 |

### Gate at 0.35

Precision 66.6, specificity 0.0, sensitivity 100.0 over 255 positives and 128 negatives.

| threshold | precision | specificity | sensitivity |
| --- | --- | --- | --- |
| 0.30 | 66.6 | 0.0 | 100.0 |
| 0.35 | 66.6 | 0.0 | 100.0 |
| 0.40 | 66.6 | 0.0 | 100.0 |
| 0.45 | 66.6 | 0.0 | 100.0 |
| 0.50 | 66.6 | 0.0 | 100.0 |
| 0.55 | 66.6 | 0.0 | 100.0 |
| 0.60 | 66.6 | 0.0 | 100.0 |
| 0.65 | 66.6 | 0.0 | 100.0 |
| 0.70 | 66.6 | 0.0 | 100.0 |
| 0.75 | 66.7 | 2.3 | 98.0 |
| 0.80 | 67.7 | 24.2 | 79.6 |
| 0.85 | 72.6 | 75.8 | 32.2 |
| 0.90 | 80.0 | 98.4 | 3.1 |
| 0.95 | 100.0 | 100.0 | 1.6 |
