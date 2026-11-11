//! Average-linkage agglomerative clustering of unit vectors by cosine
//! distance. The nearest-neighbour chain finds every merge in O(n²) time
//! and memory, and since average linkage never merges at a smaller distance
//! later, the merges sorted by distance form the dendrogram that is then cut
//! either at a distance or at a number of clusters.
//!
//! Single-window embeddings of one voice are noisy, especially far from the
//! microphone, so average linkage can leave one voice split into several
//! clusters whose members sit far apart while their centres nearly agree.
//! [`merge_centroids`] joins those by the distance between cluster centres.

use crate::models::{cosine, normalized};

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

/// The mean of `vectors`, or an empty vector when there are none.
pub fn mean(vectors: &[Vec<f32>]) -> Vec<f32> {
    let mut mean = vec![0f32; vectors.first().map_or(0, Vec::len)];
    for vector in vectors {
        for (total, value) in mean.iter_mut().zip(vector) {
            *total += value;
        }
    }
    for value in &mut mean {
        *value /= vectors.len() as f32;
    }
    mean
}

/// Cluster sums measured from `mean`: a sum of `count` vectors loses `count`
/// times the mean, so its direction is the cluster centre minus the mean.
pub fn centred_sums(sums: &[Vec<f32>], counts: &[usize], mean: &[f32]) -> Vec<Vec<f32>> {
    sums.iter()
        .zip(counts)
        .map(|(sum, &count)| {
            sum.iter()
                .zip(mean)
                .map(|(total, value)| total - count as f32 * value)
                .collect()
        })
        .collect()
}

/// Centroid linkage over cluster sums: repeatedly joins the two clusters
/// whose centres are closest while their cosine distance is below
/// `threshold`, never going below `min_clusters`. Each sum is the sum of a
/// cluster's unit vectors, so larger clusters weigh more in a joined centre.
/// Returns, for each input cluster, its group id (0..k, in order of first
/// appearance).
pub fn merge_centroids(sums: &[Vec<f32>], threshold: f32, min_clusters: usize) -> Vec<usize> {
    let mut groups: Vec<(Vec<usize>, Vec<f32>)> = sums
        .iter()
        .enumerate()
        .map(|(index, sum)| (vec![index], sum.clone()))
        .collect();
    while groups.len() > min_clusters.max(1) {
        let centres: Vec<Vec<f32>> = groups
            .iter()
            .map(|(_, sum)| normalized(sum.clone()))
            .collect();
        let mut best: Option<(usize, usize, f32)> = None;
        for a in 0..centres.len() {
            for b in a + 1..centres.len() {
                let distance = 1.0 - cosine(&centres[a], &centres[b]);
                if distance < threshold && best.is_none_or(|(_, _, d)| distance < d) {
                    best = Some((a, b, distance));
                }
            }
        }
        let Some((a, b, _)) = best else {
            break;
        };
        let (members, sum) = groups.remove(b);
        groups[a].0.extend(members);
        for (total, value) in groups[a].1.iter_mut().zip(sum) {
            *total += value;
        }
    }
    groups.sort_by_key(|(members, _)| members.iter().copied().min());
    let mut ids = vec![0; sums.len()];
    for (id, (members, _)) in groups.iter().enumerate() {
        for &member in members {
            ids[member] = id;
        }
    }
    ids
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
        assert!(merge_centroids(&[], 0.4, 1).is_empty());
    }

    #[test]
    fn joins_close_centres_and_keeps_distinct_voices() {
        // Three fragments of one voice, two of another, one distinct voice.
        let sums = vec![
            vec![10.0, 1.0, 0.0],
            vec![0.0, 0.0, 6.0],
            vec![8.0, 3.0, 0.5],
            vec![1.0, 9.0, 0.0],
            vec![6.0, -1.0, 0.5],
            vec![2.0, 7.0, 1.0],
        ];
        assert_eq!(merge_centroids(&sums, 0.2, 1), vec![0, 1, 0, 2, 0, 2]);
        // A minimum count stops the merging early.
        let labels = merge_centroids(&sums, 0.2, 5);
        assert_eq!(*labels.iter().max().unwrap() + 1, 5);
        // A zero threshold merges nothing.
        assert_eq!(merge_centroids(&sums, 0.0, 1), vec![0, 1, 2, 3, 4, 5]);
    }

    #[test]
    fn centring_separates_voices_that_share_a_microphone() {
        // Two voices whose embeddings are dominated by the same room.
        let a = normalized(vec![0.9, 0.3, 0.0, 0.0]);
        let b = normalized(vec![0.9, 0.0, 0.3, 0.0]);
        let vectors = vec![a.clone(), a.clone(), a.clone(), b.clone(), b.clone()];
        let sums = vec![
            a.iter().map(|value| value * 3.0).collect::<Vec<f32>>(),
            b.iter().map(|value| value * 2.0).collect(),
        ];
        assert_eq!(merge_centroids(&sums, 0.8, 1), vec![0, 0]);
        let centred = centred_sums(&sums, &[3, 2], &mean(&vectors));
        assert_eq!(merge_centroids(&centred, 0.8, 1), vec![0, 1]);
        assert!(mean(&[]).is_empty());
    }
}
