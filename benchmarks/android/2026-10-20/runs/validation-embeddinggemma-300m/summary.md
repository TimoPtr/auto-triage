## Retrieval eval (production)

383 of 385 cases scored, errors: 2; model `onnx-community/embeddinggemma-300m-ONNX@5090578d9565bb06545b4552f76e6bc2c93e4a66@q8@mean@q=task: search result | query: @d=title: none | text: `; index built 2026-10-20T11:19:39.488Z; 121.5 s.

All positives: n 255, recall@5 31.0, MRR 0.199.

### By relation

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 53 | 20.8 | 0.128 |
| duplicate | 49 | 55.1 | 0.380 |
| fixed-by | 153 | 26.8 | 0.166 |

### By expected source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| docs | 53 | 20.8 | 0.128 |
| issue | 48 | 56.3 | 0.388 |
| pull | 154 | 26.6 | 0.165 |

### By label source

| group | n | recall@5 | MRR |
| --- | --- | --- | --- |
| comment:docs-link | 53 | 20.8 | 0.128 |
| comment:duplicate-of | 37 | 54.1 | 0.381 |
| pull:closing-reference | 153 | 26.8 | 0.166 |
| timeline:marked-duplicate | 12 | 58.3 | 0.378 |

### Gate at 0.35

Precision 66.6, specificity 0.8, sensitivity 99.2 over 255 positives and 128 negatives.

| threshold | precision | specificity | sensitivity |
| --- | --- | --- | --- |
| 0.30 | 66.6 | 0.8 | 99.2 |
| 0.35 | 66.6 | 0.8 | 99.2 |
| 0.40 | 66.6 | 0.8 | 99.2 |
| 0.45 | 66.6 | 0.8 | 99.2 |
| 0.50 | 66.6 | 0.8 | 99.2 |
| 0.55 | 66.6 | 0.8 | 99.2 |
| 0.60 | 66.6 | 0.8 | 99.2 |
| 0.65 | 66.6 | 0.8 | 99.2 |
| 0.70 | 66.6 | 0.8 | 99.2 |
| 0.75 | 66.8 | 4.7 | 96.1 |
| 0.80 | 66.9 | 19.5 | 81.6 |
| 0.85 | 67.5 | 59.4 | 42.4 |
| 0.90 | 75.0 | 92.2 | 11.8 |
| 0.95 | n/a | 100.0 | 0.0 |
