#!/usr/bin/env python3
"""Score dense candidate pools with a local open-weight embedding model (no API calls).

Reads pools written by `run.ts --dump-pool` and writes `--dense-scores` input for the `dense` and
`hybrid-dense` arms: per task, the cosine similarity of each pool chunk to the task query.
Needs `pip install fastembed numpy`. Chunk texts are deduplicated across tasks before embedding.

  python3 embed_pools.py --pools 'res/pools-*.jsonl' --out res/dense-scores.jsonl \
    --model jinaai/jina-embeddings-v2-base-code --threads 4
"""

import argparse
import gc
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
    ap.add_argument("--workers", type=int, default=1)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--max-length", type=int, default=512)
    ap.add_argument("--cache-dir", default=None)
    ap.add_argument("--max-chars", type=int, default=3000)
    ap.add_argument("--segment", type=int, default=1000, help="chunks per fresh model session")
    ap.add_argument("--work-dir", default=None, help="finished segments (default: <out>.parts)")
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

    def load():
        return TextEmbedding(
            args.model,
            max_length=args.max_length,
            threads=args.threads,
            cache_dir=args.cache_dir,
        )

    # ONNX Runtime's arena grows with every new input shape and never shrinks, so a long run on
    # variable-length chunks exhausts memory. Embed length-sorted segments with a fresh session each
    # and keep every finished segment on disk, so memory stays bounded and a rerun resumes.
    keys.sort(key=lambda k: len(texts[k]))
    work = args.work_dir or args.out + ".parts"
    os.makedirs(work, exist_ok=True)
    t0 = time.time()
    parts = []
    for i in range(0, len(keys), args.segment):
        seg = keys[i : i + args.segment]
        path = os.path.join(
            work, hashlib.sha1((args.model + "".join(seg)).encode()).hexdigest()[:16] + ".npy"
        )
        if not os.path.exists(path):
            model = load()
            vectors = np.asarray(
                list(
                    model.passage_embed(
                        # Not every model's tokenizer honours max_length; a minified line can be
                        # tens of thousands of tokens, so cap characters as well.
                        [texts[k][: args.max_chars] for k in seg],
                        batch_size=args.batch,
                        parallel=args.workers if args.workers > 1 else None,
                    )
                ),
                dtype=np.float32,
            )
            del model
            gc.collect()
            np.save(path + ".tmp.npy", vectors)
            os.replace(path + ".tmp.npy", path)
        parts.append(np.load(path))
        print(f"{min(i + args.segment, len(keys))}/{len(keys)} chunks, {time.time() - t0:.0f}s", flush=True)
    passages = np.concatenate(parts) if parts else np.zeros((0, 1), dtype=np.float32)
    model = load()
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
