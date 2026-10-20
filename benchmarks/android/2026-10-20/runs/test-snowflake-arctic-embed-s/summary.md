## Retrieval eval (production)

391 of 392 cases scored, errors: 1; model `Snowflake/snowflake-arctic-embed-s@e596f507467533e48a2e17c007f0e1dacc837b33@q8@cls@q=Represent this sentence for searching relevant passages: @d=`; index built 2026-10-20T10:13:03.392Z; 89.8 s.

All positives: n 282, recall@5 38.7, MRR 0.243.

### By relation

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 69 | 30.4 | 0.145 |
| duplicate | 55 | 58.2 | 0.420 |
| fixed-by | 157 | 35.0 | 0.219 |
| forum | 1 | 100.0 | 1.000 |

### By expected source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 69 | 30.4 | 0.145 |
| forum | 1 | 100.0 | 1.000 |
| issue | 55 | 58.2 | 0.420 |
| pull | 157 | 35.0 | 0.219 |

### By label source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| comment:docs-link | 69 | 30.4 | 0.145 |
| comment:duplicate-of | 37 | 64.9 | 0.472 |
| comment:forum-link | 1 | 100.0 | 1.000 |
| pull:closing-reference | 157 | 35.0 | 0.219 |
| timeline:marked-duplicate | 18 | 44.4 | 0.314 |

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
| 0.65 | 72.1 | 0.0 | 99.6 |
| 0.70 | 72.0 | 0.0 | 99.3 |
| 0.75 | 72.4 | 3.7 | 97.5 |
| 0.80 | 75.3 | 33.9 | 78.0 |
| 0.85 | 78.6 | 80.7 | 27.3 |
| 0.90 | 83.3 | 98.2 | 3.5 |
| 0.95 | n/a | 100.0 | 0.0 |
