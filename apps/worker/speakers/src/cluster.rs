//! Average-linkage agglomerative clustering of unit vectors by cosine
//! distance. The nearest-neighbour chain finds every merge in O(n²) time
//! and memory, and since average linkage never merges at a smaller distance
//! later, the merges sorted by distance form the dendrogram that is then cut
//! either at a distance or at a number of clusters.

use crate::models::cosine;

struct Condensed {
    n: usize,
    values: Vec<f32>,
}

impl Condensed {
    fn index(&self, a: usize, b: usize) -> usize {
        let (i, j) = if a < b { (a, b) } else { (b, a) };
        // Row i holds the distances to j in i+1..n.
        i * self.n - i * (i + 1) / 2 + (j - i - 1)
    }
    fn get(&self, a: usize, b: usize) -> f32 {
        self.values[self.index(a, b)]
    }
    fn set(&mut self, a: usize, b: usize, value: f32) {
        let index = self.index(a, b);
        self.values[index] = value;
    }
}

/// One merge: two cluster representatives and their average distance.
#[derive(Clone, Copy, Debug)]
pub struct Merge {
    pub left: usize,
    pub right: usize,
    pub distance: f32,
}

/// Every merge of the dendrogram, closest first.
pub fn dendrogram(vectors: &[Vec<f32>]) -> Vec<Merge> {
    let n = vectors.len();
    if n < 2 {
        return Vec::new();
    }
    let mut distances = Condensed {
        n,
        values: vec![0.0; n * (n - 1) / 2],
    };
    for a in 0..n {
        for b in a + 1..n {
            distances.set(a, b, 1.0 - cosine(&vectors[a], &vectors[b]));
        }
    }
    let mut size = vec![1usize; n];
    let mut active = vec![true; n];
    let mut merges = Vec::with_capacity(n - 1);
    let mut chain: Vec<usize> = Vec::new();
    while merges.len() < n - 1 {
        if chain.is_empty() {
            chain.push(active.iter().position(|&alive| alive).unwrap());
        }
        loop {
            let top = *chain.last().unwrap();
            let previous = if chain.len() >= 2 {
                Some(chain[chain.len() - 2])
            } else {
                None
            };
            // Prefer the previous element on ties so the chain terminates.
            let mut best = previous;
            let mut best_distance = previous.map_or(f32::INFINITY, |p| distances.get(top, p));
            for other in 0..n {
                if other == top || !active[other] {
                    continue;
                }
                let distance = distances.get(top, other);
                if distance < best_distance {
                    best_distance = distance;
                    best = Some(other);
                }
            }
            let best = best.unwrap();
            if Some(best) == previous {
                chain.pop();
                chain.pop();
                // Merge `top` into `best`, keeping `best` as the representative.
                let (keep, gone) = (best, top);
                merges.push(Merge {
                    left: keep,
                    right: gone,
                    distance: best_distance,
                });
                let (keep_size, gone_size) = (size[keep] as f32, size[gone] as f32);
                for other in 0..n {
                    if other == keep || other == gone || !active[other] {
                        continue;
                    }
                    let merged = (keep_size * distances.get(keep, other)
                        + gone_size * distances.get(gone, other))
                        / (keep_size + gone_size);
                    distances.set(keep, other, merged);
                }
                active[gone] = false;
                size[keep] += size[gone];
                break;
            }
            chain.push(best);
        }
    }
    merges.sort_by(|a, b| a.distance.total_cmp(&b.distance));
    merges
}

fn find(parent: &mut [usize], mut node: usize) -> usize {
    while parent[node] != node {
        parent[node] = parent[parent[node]];
        node = parent[node];
    }
    node
}

/// Cluster ids (0..k, in order of first appearance) after applying merges
/// closer than `threshold`, then continuing until at most `max_clusters`
/// remain, and stopping early at `min_clusters`.
pub fn cut(
    n: usize,
    merges: &[Merge],
    threshold: f32,
    min_clusters: usize,
    max_clusters: usize,
) -> Vec<usize> {
    let mut parent: Vec<usize> = (0..n).collect();
    let mut clusters = n;
    for merge in merges {
        if clusters <= min_clusters.max(1) {
            break;
        }
        if merge.distance >= threshold && clusters <= max_clusters {
            break;
        }
        let (a, b) = (
            find(&mut parent, merge.left),
            find(&mut parent, merge.right),
        );
        if a != b {
            parent[b] = a;
            clusters -= 1;
        }
    }
    let mut ids = std::collections::HashMap::new();
    (0..n)
        .map(|node| {
            let root = find(&mut parent, node);
            let next = ids.len();
            *ids.entry(root).or_insert(next)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::normalized;

    fn around(direction: &[f32], jitter: f32, seed: usize) -> Vec<f32> {
        normalized(
            direction
                .iter()
                .enumerate()
                .map(|(i, value)| {
                    value + jitter * (((seed * 31 + i * 17) % 13) as f32 / 13.0 - 0.5)
                })
                .collect(),
        )
    }

    #[test]
    fn separates_two_voices_by_threshold_and_by_count() {
        let a = [1.0, 0.0, 0.0, 0.2];
        let b = [0.0, 1.0, 0.1, 0.0];
        let mut vectors = Vec::new();
        for seed in 0..6 {
            vectors.push(around(&a, 0.2, seed));
            vectors.push(around(&b, 0.2, seed + 100));
        }
        let merges = dendrogram(&vectors);
        assert_eq!(merges.len(), vectors.len() - 1);
        let labels = cut(vectors.len(), &merges, 0.5, 1, usize::MAX);
        for pair in labels.chunks(2) {
            assert_eq!(pair, [labels[0], labels[1]]);
        }
        assert_ne!(labels[0], labels[1]);
        // A count of one merges everything; a minimum of four splits a voice.
        assert!(
            cut(vectors.len(), &merges, 0.5, 1, 1)
                .iter()
                .all(|&label| label == 0)
        );
        let four = cut(vectors.len(), &merges, 2.0, 4, usize::MAX);
        assert_eq!(*four.iter().max().unwrap() + 1, 4);
    }

    #[test]
    fn handles_tiny_inputs() {
        assert!(dendrogram(&[]).is_empty());
        assert_eq!(cut(1, &[], 0.5, 1, 4), vec![0]);
    }
}
