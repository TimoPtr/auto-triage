| model | key | build s | index MB | chunks/s | recall@5 | MRR | gate precision | gate specificity | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all-MiniLM-L6-v2 | `Xenova/all-MiniLM-L6-v2@751bff37182d3f1213fa05d7196b954e230abad9@q8@mean` | 306.0 | 86.6 | 135 | 29.0 | 0.190 | 66.5 | 0.0 |  |
| bge-small-en-v1.5 | `Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3@q8@cls` | 514.4 | 86.6 | 81 | 30.6 | 0.203 | 66.6 | 0.0 |  |
| snowflake-arctic-embed-s | `Snowflake/snowflake-arctic-embed-s@e596f507467533e48a2e17c007f0e1dacc837b33@q8@cls@q=Represent this sentence for searching relevant passages: @d=` | 536.8 | 86.6 | 77 | 34.9 | 0.215 | 66.6 | 0.0 |  |
| nomic-embed-text-v1.5 | `nomic-ai/nomic-embed-text-v1.5@e9b6763023c676ca8431644204f50c2b100d9aab@q8@mean@q=search_query: @d=search_document: ` | 1882.9 | 102.0 | 22 | 29.8 | 0.186 | 66.6 | 0.0 |  |
| embeddinggemma-300m | `onnx-community/embeddinggemma-300m-ONNX@5090578d9565bb06545b4552f76e6bc2c93e4a66@q8@mean@q=task: search result | query: @d=title: none | text: ` | 1833.6 | 102.0 | 23 | 28.6 | 0.192 | 66.6 | 0.8 |  |
