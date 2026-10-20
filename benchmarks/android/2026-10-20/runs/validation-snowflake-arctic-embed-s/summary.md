## Retrieval eval (production)

383 of 385 cases scored, errors: 2; model `Snowflake/snowflake-arctic-embed-s@e596f507467533e48a2e17c007f0e1dacc837b33@q8@cls@q=Represent this sentence for searching relevant passages: @d=`; index built 2026-10-20T10:13:03.392Z; 83.8 s.

All positives: n 255, recall@5 34.1, MRR 0.227.

### By relation

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 53 | 11.3 | 0.105 |
| duplicate | 49 | 55.1 | 0.406 |
| fixed-by | 153 | 35.3 | 0.211 |

### By expected source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 53 | 11.3 | 0.105 |
| issue | 48 | 56.3 | 0.414 |
| pull | 154 | 35.1 | 0.210 |

### By label source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| comment:docs-link | 53 | 11.3 | 0.105 |
| comment:duplicate-of | 37 | 56.8 | 0.434 |
| pull:closing-reference | 153 | 35.3 | 0.211 |
| timeline:marked-duplicate | 12 | 50.0 | 0.318 |

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
| 0.65 | 66.5 | 0.0 | 99.6 |
| 0.70 | 66.4 | 0.0 | 99.2 |
| 0.75 | 66.2 | 1.6 | 96.9 |
| 0.80 | 69.3 | 34.4 | 74.5 |
| 0.85 | 77.9 | 86.7 | 23.5 |
| 0.90 | 87.5 | 99.2 | 2.7 |
| 0.95 | 100.0 | 100.0 | 0.8 |
