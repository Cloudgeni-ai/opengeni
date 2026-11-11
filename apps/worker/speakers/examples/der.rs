//! Diarization error rate of `opengeni-speakers diarize` output against a
//! reference RTTM, scored inside a UEM with no forgiveness collar and with
//! overlapping speech included (the AMI "only words" protocol).
//!
//! cargo run --release --example der -- REF.rttm REF.uem HYP.json

#![allow(clippy::needless_range_loop)]

use std::collections::HashMap;

const STEP_MS: f64 = 10.0;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [rttm, uem, hyp] = [&args[0], &args[1], &args[2]];
    let uem = std::fs::read_to_string(uem).unwrap();
    let fields: Vec<&str> = uem.split_whitespace().collect();
    let (from, to): (f64, f64) = (fields[2].parse().unwrap(), fields[3].parse().unwrap());
    let frames = ((to - from) * 1000.0 / STEP_MS) as usize;
    let frame_of = |seconds: f64| {
        (((seconds - from) * 1000.0 / STEP_MS).round().max(0.0) as usize).min(frames)
    };

    let mut reference: HashMap<String, Vec<bool>> = HashMap::new();
    for line in std::fs::read_to_string(rttm).unwrap().lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.first() != Some(&"SPEAKER") {
            continue;
        }
        let (start, duration): (f64, f64) = (f[3].parse().unwrap(), f[4].parse().unwrap());
        let track = reference
            .entry(f[7].to_string())
            .or_insert_with(|| vec![false; frames]);
        for frame in frame_of(start)..frame_of(start + duration) {
            track[frame] = true;
        }
    }
    let output: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(hyp).unwrap()).unwrap();
    let mut hypothesis: HashMap<u64, Vec<bool>> = HashMap::new();
    for turn in output["turns"].as_array().unwrap() {
        let start = turn["startMs"].as_f64().unwrap() / 1000.0;
        let end = turn["endMs"].as_f64().unwrap() / 1000.0;
        let track = hypothesis
            .entry(turn["speaker"].as_u64().unwrap())
            .or_insert_with(|| vec![false; frames]);
        for frame in frame_of(start)..frame_of(end) {
            track[frame] = true;
        }
    }
    let refs: Vec<&Vec<bool>> = reference.values().collect();
    let hyps: Vec<&Vec<bool>> = hypothesis.values().collect();
    // Overlap in frames between every reference and hypothesis speaker.
    let overlap: Vec<Vec<f64>> = refs
        .iter()
        .map(|r| {
            hyps.iter()
                .map(|h| r.iter().zip(h.iter()).filter(|(a, b)| **a && **b).count() as f64)
                .collect()
        })
        .collect();
    let mapping = hungarian(&overlap);
    let (mut total, mut miss, mut false_alarm, mut confusion) = (0f64, 0f64, 0f64, 0f64);
    for frame in 0..frames {
        let active_refs: Vec<usize> = (0..refs.len()).filter(|&r| refs[r][frame]).collect();
        let active_hyps = (0..hyps.len()).filter(|&h| hyps[h][frame]).count();
        let correct = active_refs
            .iter()
            .filter(|&&r| mapping[r].is_some_and(|h| hyps[h][frame]))
            .count();
        let n_ref = active_refs.len();
        total += n_ref as f64;
        miss += n_ref.saturating_sub(active_hyps) as f64;
        false_alarm += active_hyps.saturating_sub(n_ref) as f64;
        confusion += (n_ref.min(active_hyps) - correct) as f64;
    }
    let pct = |value: f64| 100.0 * value / total;
    println!(
        "{}",
        serde_json::json!({
            "der": pct(miss + false_alarm + confusion),
            "miss": pct(miss),
            "falseAlarm": pct(false_alarm),
            "confusion": pct(confusion),
            "refSpeakers": refs.len(),
            "hypSpeakers": hyps.len(),
            "elapsedMs": output["elapsedMs"],
            "audioMs": output["audioMs"],
        })
    );
}

/// Maximum-weight one-to-one matching of rows to columns.
fn hungarian(weights: &[Vec<f64>]) -> Vec<Option<usize>> {
    let rows = weights.len();
    let cols = weights.first().map_or(0, Vec::len);
    let n = rows.max(cols);
    if n == 0 {
        return vec![None; rows];
    }
    let max = weights.iter().flatten().cloned().fold(0.0, f64::max);
    // Square cost matrix (minimization), padded with zero-weight cells.
    let cost = |r: usize, c: usize| {
        max - if r < rows && c < cols {
            weights[r][c]
        } else {
            0.0
        }
    };
    let (mut u, mut v) = (vec![0.0; n + 1], vec![0.0; n + 1]);
    let (mut p, mut way) = (vec![0usize; n + 1], vec![0usize; n + 1]);
    for i in 1..=n {
        p[0] = i;
        let mut j0 = 0;
        let mut minv = vec![f64::INFINITY; n + 1];
        let mut used = vec![false; n + 1];
        loop {
            used[j0] = true;
            let i0 = p[j0];
            let mut delta = f64::INFINITY;
            let mut j1 = 0;
            for j in 1..=n {
                if !used[j] {
                    let cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
                    if cur < minv[j] {
                        minv[j] = cur;
                        way[j] = j0;
                    }
                    if minv[j] < delta {
                        delta = minv[j];
                        j1 = j;
                    }
                }
            }
            for j in 0..=n {
                if used[j] {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
            if p[j0] == 0 {
                break;
            }
        }
        loop {
            let j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
            if j0 == 0 {
                break;
            }
        }
    }
    let mut assignment = vec![None; rows];
    for j in 1..=n {
        let (r, c) = (p[j] - 1, j - 1);
        if r < rows && c < cols && weights[r][c] > 0.0 {
            assignment[r] = Some(c);
        }
    }
    assignment
}
