## Retrieval eval (production)

383 of 385 cases scored, errors: 2; model `Xenova/all-MiniLM-L6-v2@751bff37182d3f1213fa05d7196b954e230abad9@q8@mean`; index built 2026-10-20T09:52:47.132Z; 77.8 s.

All positives: n 255, recall@5 29.0, MRR 0.202.

### By relation

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 53 | 17.0 | 0.117 |
| duplicate | 49 | 49.0 | 0.330 |
| fixed-by | 153 | 26.8 | 0.190 |

### By expected source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 53 | 17.0 | 0.117 |
| issue | 48 | 50.0 | 0.337 |
| pull | 154 | 26.6 | 0.189 |

### By label source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| comment:docs-link | 53 | 17.0 | 0.117 |
| comment:duplicate-of | 37 | 48.6 | 0.333 |
| pull:closing-reference | 153 | 26.8 | 0.190 |
| timeline:marked-duplicate | 12 | 50.0 | 0.322 |

### Gate at 0.35

Precision 66.5, specificity 0.0, sensitivity 99.6 over 255 positives and 128 negatives.

| threshold | precision | specificity | sensitivity |
| --- | --- | --- | --- |
| 0.30 | 66.5 | 0.0 | 99.6 |
| 0.35 | 66.5 | 0.0 | 99.6 |
| 0.40 | 66.7 | 0.8 | 99.6 |
| 0.45 | 66.7 | 0.8 | 99.6 |
| 0.50 | 66.8 | 1.6 | 99.6 |
| 0.55 | 66.8 | 3.1 | 98.0 |
| 0.60 | 66.9 | 7.8 | 93.7 |
| 0.65 | 67.0 | 21.9 | 79.6 |
| 0.70 | 68.6 | 50.0 | 54.9 |
| 0.75 | 69.7 | 76.6 | 27.1 |
| 0.80 | 66.7 | 91.4 | 8.6 |
| 0.85 | 83.3 | 98.4 | 3.9 |
| 0.90 | 100.0 | 100.0 | 2.0 |
| 0.95 | 100.0 | 100.0 | 0.8 |
