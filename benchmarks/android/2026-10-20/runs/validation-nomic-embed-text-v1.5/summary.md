## Retrieval eval (production)

383 of 385 cases scored, errors: 2; model `nomic-ai/nomic-embed-text-v1.5@e9b6763023c676ca8431644204f50c2b100d9aab@q8@mean@q=search_query: @d=search_document: `; index built 2026-10-20T10:45:50.326Z; 194.3 s.

All positives: n 255, recall@5 31.8, MRR 0.207.

### By relation

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 53 | 24.5 | 0.145 |
| duplicate | 49 | 51.0 | 0.346 |
| fixed-by | 153 | 28.1 | 0.184 |

### By expected source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 53 | 24.5 | 0.145 |
| issue | 48 | 52.1 | 0.354 |
| pull | 154 | 27.9 | 0.183 |

### By label source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| comment:docs-link | 53 | 24.5 | 0.145 |
| comment:duplicate-of | 37 | 51.4 | 0.363 |
| pull:closing-reference | 153 | 28.1 | 0.184 |
| timeline:marked-duplicate | 12 | 50.0 | 0.296 |

### Gate at 0.35

Precision 66.6, specificity 0.0, sensitivity 100.0 over 255 positives and 128 negatives.

| threshold | precision | specificity | sensitivity |
| --- | --- | --- | --- |
| 0.30 | 66.6 | 0.0 | 100.0 |
| 0.35 | 66.6 | 0.0 | 100.0 |
| 0.40 | 66.6 | 0.0 | 100.0 |
| 0.45 | 66.6 | 0.0 | 100.0 |
| 0.50 | 66.6 | 0.0 | 100.0 |
| 0.55 | 66.0 | 0.0 | 97.6 |
| 0.60 | 65.8 | 0.0 | 96.5 |
| 0.65 | 65.9 | 2.3 | 94.9 |
| 0.70 | 66.2 | 5.5 | 92.9 |
| 0.75 | 66.0 | 10.9 | 86.7 |
| 0.80 | 68.3 | 48.4 | 55.7 |
| 0.85 | 76.8 | 89.8 | 16.9 |
| 0.90 | 87.5 | 99.2 | 2.7 |
| 0.95 | 100.0 | 100.0 | 0.8 |
