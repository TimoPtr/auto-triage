## Retrieval eval (oracle)

1326 of 1925 cases scored, errors: 8; model `Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3@q8@cls`; index built 2026-10-19T09:15:01.164Z; 278.1 s.

All positives: n 1326, recall@5 99.5, MRR 0.988.

### By relation

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 316 | 100.0 | 1.000 |
| duplicate | 259 | 97.3 | 0.942 |
| fixed-by | 743 | 100.0 | 1.000 |
| forum | 8 | 100.0 | 0.900 |

### By expected source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 316 | 100.0 | 1.000 |
| forum | 8 | 100.0 | 0.900 |
| issue | 257 | 97.3 | 0.941 |
| pull | 745 | 100.0 | 1.000 |

### By label source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| comment:docs-link | 316 | 100.0 | 1.000 |
| comment:duplicate-of | 183 | 97.3 | 0.936 |
| comment:forum-link | 8 | 100.0 | 0.900 |
| pull:closing-reference | 743 | 100.0 | 1.000 |
| timeline:marked-duplicate | 76 | 97.4 | 0.956 |

### Gate at 0.35

Precision 100.0, specificity n/a, sensitivity 100.0 over 1326 positives and 0 negatives.

| threshold | precision | specificity | sensitivity |
| --- | --- | --- | --- |
| 0.30 | 100.0 | n/a | 100.0 |
| 0.35 | 100.0 | n/a | 100.0 |
| 0.40 | 100.0 | n/a | 100.0 |
| 0.45 | 100.0 | n/a | 100.0 |
| 0.50 | 100.0 | n/a | 100.0 |
| 0.55 | 100.0 | n/a | 100.0 |
| 0.60 | 100.0 | n/a | 100.0 |
| 0.65 | 100.0 | n/a | 100.0 |
| 0.70 | 100.0 | n/a | 100.0 |
| 0.75 | 100.0 | n/a | 100.0 |
| 0.80 | 100.0 | n/a | 100.0 |
| 0.85 | 100.0 | n/a | 100.0 |
| 0.90 | 100.0 | n/a | 98.2 |
| 0.95 | 100.0 | n/a | 87.0 |
