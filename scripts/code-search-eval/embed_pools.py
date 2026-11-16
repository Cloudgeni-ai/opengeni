#!/usr/bin/env python3
"""Score dense candidate pools with a local open-weight embedding model (no API calls).

Reads pools written by `run.ts --dump-pool` and writes `--dense-scores` input for the `dense` and
`hybrid-dense` arms: per task, the cosine similarity of each pool chunk to the task query.
Needs `pip install fastembed numpy`. Chunk texts are deduplicated across tasks before embedding.

  python3 embed_pools.py --pools 'res/pools-*.jsonl' --out res/dense-scores.jsonl \
    --model jinaai/jina-embeddings-v2-base-code --workers 4 --threads 8
"""

import argparse
import glob
import hashlib
import json
import os
import time

import numpy as np


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pools", required=True, help="glob of pool JSONL files")
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="jinaai/jina-embeddings-v2-base-code")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--max-length", type=int, default=512)
    ap.add_argument("--cache-dir", default=None)
    args = ap.parse_args()

    tasks = []
    for path in sorted(glob.glob(args.pools)):
        with open(path) as f:
            tasks.extend(json.loads(line) for line in f if line.strip())
    texts: dict[str, str] = {}
    for t in tasks:
        for c in t["pool"]:
            texts.setdefault(hashlib.sha1(c["text"].encode()).hexdigest(), c["text"])
    keys = list(texts)
    print(f"{len(tasks)} tasks, {len(keys)} unique chunks", flush=True)

    from fastembed import TextEmbedding

    os.environ.setdefault("OMP_NUM_THREADS", str(args.threads))
    model = TextEmbedding(
        args.model,
        max_length=args.max_length,
        threads=args.threads,
        cache_dir=args.cache_dir,
    )
    t0 = time.time()
    passages = np.asarray(
        list(
            model.passage_embed(
                [texts[k] for k in keys],
                batch_size=args.batch,
                parallel=args.workers if args.workers > 1 else None,
            )
        ),
        dtype=np.float32,
    )
    queries = np.asarray(
        list(model.query_embed([t["query"] for t in tasks], batch_size=args.batch)),
        dtype=np.float32,
    )
    elapsed = time.time() - t0
    passages /= np.linalg.norm(passages, axis=1, keepdims=True) + 1e-9
    queries /= np.linalg.norm(queries, axis=1, keepdims=True) + 1e-9
    row = {k: i for i, k in enumerate(keys)}

    with open(args.out, "w") as out:
        for t, q in zip(tasks, queries):
            chunks = []
            for c in t["pool"]:
                v = passages[row[hashlib.sha1(c["text"].encode()).hexdigest()]]
                chunks.append(
                    {"file": c["file"], "start": c["start"], "end": c["end"], "score": float(v @ q)}
                )
            out.write(json.dumps({"taskId": t["taskId"], "chunks": chunks}) + "\n")
    rate = (len(keys) + len(tasks)) / max(elapsed, 1e-9)
    print(f"embedded {len(keys)} chunks and {len(tasks)} queries in {elapsed:.0f}s ({rate:.1f}/s)")


if __name__ == "__main__":
    main()
