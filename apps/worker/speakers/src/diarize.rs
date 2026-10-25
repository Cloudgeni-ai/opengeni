//! Who spoke when, following the pyannote 3 recipe:
//!
//! 1. Slide a 10 s window over the audio and let the segmentation model say,
//!    per ~17 ms frame, which of up to three local speakers talk.
//! 2. Embed each local speaker's speech in each window.
//! 3. Cluster the embeddings with enough clean speech into global speakers,
//!    and dissolve clusters too small to be a real participant.
//! 4. Map each window's local speakers to distinct global speakers.
//! 5. Average the windows' activity per frame, keep as many speakers per
//!    frame as the windows counted, and turn frames into speaker turns.

use crate::cluster;
use crate::models::{Embedder, MIN_EMBEDDING_SAMPLES, Result, Segmentation, cosine, normalized};
use serde::Serialize;
use std::ops::Range;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

pub const SAMPLE_RATE: usize = 16_000;

#[derive(Clone, Debug)]
pub struct Options {
    /// Seconds between window starts.
    pub step_seconds: f32,
    /// Cosine distance below which voices are one speaker.
    pub threshold: f32,
    pub min_speakers: usize,
    pub max_speakers: usize,
    /// Clusters with fewer clean embeddings than this are not speakers of
    /// their own; their windows join the closest real speaker.
    pub min_cluster_size: usize,
    /// Seconds of speech, alone, a window needs for its embedding to help
    /// form the clusters.
    pub min_clean_seconds: f32,
    /// Shortest turn kept, and longest same-speaker gap bridged, in seconds.
    pub min_turn_seconds: f32,
    pub min_gap_seconds: f32,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            step_seconds: 2.0,
            threshold: 0.55,
            min_speakers: 1,
            max_speakers: usize::MAX,
            min_cluster_size: 12,
            min_clean_seconds: 2.0,
            min_turn_seconds: 0.0,
            min_gap_seconds: 0.0,
        }
    }
}

/// Most embeddings clustered directly. The distance matrix grows with the
/// square, so longer recordings cluster an even sample and assign the rest
/// to the resulting speakers like every other window.
const MAX_CLUSTERED: usize = 4_000;

#[derive(Serialize, Debug, Clone)]
pub struct Turn {
    #[serde(rename = "startMs")]
    pub start_ms: u64,
    #[serde(rename = "endMs")]
    pub end_ms: u64,
    pub speaker: usize,
}

#[derive(Serialize, Debug, Clone)]
pub struct Speaker {
    pub speaker: usize,
    #[serde(rename = "speechMs")]
    pub speech_ms: u64,
    pub embedding: Vec<f32>,
}

#[derive(Serialize, Debug, Default)]
pub struct Diarization {
    pub turns: Vec<Turn>,
    pub speakers: Vec<Speaker>,
}

struct Window {
    start: usize,
    /// Per frame, a bitmask of the active local speakers.
    masks: Vec<u8>,
}

/// One local speaker in one window, with the audio it spoke.
struct Local {
    window: usize,
    speaker: usize,
    clean: bool,
    embedding: Option<Vec<f32>>,
}

fn segment(model: &mut Segmentation, audio: &[f32], step: usize) -> Result<(Vec<Window>, usize)> {
    let mut starts = vec![0usize];
    while starts.last().unwrap() + model.window < audio.len() {
        starts.push(starts.last().unwrap() + step);
    }
    // Windows per segmentation run. The arena keeps the largest run's
    // activations for the whole process, about 25 MB per window, and more
    // windows per run save no measurable CPU.
    const BATCH: usize = 4;
    let mut windows = Vec::with_capacity(starts.len());
    let mut frames = 0;
    for batch in starts.chunks(BATCH) {
        let mut samples = vec![0f32; batch.len() * model.window];
        for (index, &start) in batch.iter().enumerate() {
            let end = (start + model.window).min(audio.len());
            samples[index * model.window..index * model.window + (end - start)]
                .copy_from_slice(&audio[start..end]);
        }
        let (masks, count) = model.activity(samples, batch.len())?;
        frames = count;
        for (index, &start) in batch.iter().enumerate() {
            windows.push(Window {
                start,
                masks: masks[index * count..(index + 1) * count].to_vec(),
            });
        }
    }
    Ok((windows, frames))
}

/// Where a local speaker spoke in a window, as stretches of the audio:
/// frames where only they talk when there is enough of it, otherwise every
/// frame they talk in. Stretches, not copies, so every window's speech is
/// never held at once; the second value says whether it is clean speech.
fn local_runs(
    audio_len: usize,
    window: &Window,
    window_samples: usize,
    speaker: usize,
    min_clean: usize,
) -> (Vec<Range<usize>>, bool) {
    let frames = window.masks.len();
    let gather = |only: bool| -> Vec<Range<usize>> {
        let mut out = Vec::new();
        let mut run: Option<usize> = None;
        for frame in 0..=frames {
            let on = frame < frames && {
                let mask = window.masks[frame];
                if only {
                    mask == 1 << speaker
                } else {
                    mask & (1 << speaker) != 0
                }
            };
            match (on, run) {
                (true, None) => run = Some(frame),
                (false, Some(first)) => {
                    let from = window.start + first * window_samples / frames;
                    let to = (window.start + frame * window_samples / frames).min(audio_len);
                    if from < to {
                        out.push(from..to);
                    }
                    run = None;
                }
                _ => {}
            }
        }
        out
    };
    let clean = gather(true);
    if run_samples(&clean) >= min_clean {
        (clean, true)
    } else {
        (gather(false), false)
    }
}

fn run_samples(runs: &[Range<usize>]) -> usize {
    runs.iter().map(|run| run.len()).sum()
}

/// The samples of the stretches, joined.
fn gather(audio: &[f32], runs: &[Range<usize>]) -> Vec<f32> {
    let mut out = Vec::with_capacity(run_samples(runs));
    for run in runs {
        out.extend_from_slice(&audio[run.clone()]);
    }
    out
}

/// Embed `count` pieces of audio over the embedders (one per thread). Each
/// thread takes the next piece when it is free and asks `samples` for it
/// only then, so only one piece per thread is in memory at a time.
pub fn embed_all<F, S>(
    embedders: &mut [Embedder],
    count: usize,
    samples: F,
) -> Result<Vec<Vec<f32>>>
where
    F: Fn(usize) -> S + Sync,
    S: AsRef<[f32]>,
{
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    // Each thread returns the (index, embedding) pairs it computed.
    type Done = Vec<(usize, Vec<f32>)>;
    let results: Vec<Result<Done>> = std::thread::scope(|scope| {
        let handles: Vec<_> = embedders
            .iter_mut()
            .take(count.max(1))
            .map(|embedder| {
                let (next, failed, samples) = (&next, &failed, &samples);
                scope.spawn(move || {
                    let mut done = Vec::new();
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        if index >= count || failed.load(Ordering::Relaxed) {
                            return Ok(done);
                        }
                        match embedder.embed(samples(index).as_ref()) {
                            Ok(vector) => done.push((index, vector)),
                            Err(error) => {
                                failed.store(true, Ordering::Relaxed);
                                return Err(error);
                            }
                        }
                    }
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("embedding thread"))
            .collect()
    });
    let mut out = vec![Vec::new(); count];
    for result in results {
        for (index, vector) in result? {
            out[index] = vector;
        }
    }
    Ok(out)
}

/// Give each window's local speakers distinct global speakers, maximizing
/// the total similarity. Windows hold at most three local speakers, so
/// trying every assignment is cheap.
fn assign(similarities: &[Vec<f32>], speakers: usize) -> Vec<Option<usize>> {
    let locals = similarities.len();
    let mut best = vec![None; locals];
    let mut best_score = f32::NEG_INFINITY;
    let mut current = vec![None; locals];
    fn search(
        index: usize,
        similarities: &[Vec<f32>],
        speakers: usize,
        used: &mut Vec<bool>,
        current: &mut Vec<Option<usize>>,
        score: f32,
        best: &mut Vec<Option<usize>>,
        best_score: &mut f32,
    ) {
        if index == similarities.len() {
            if score > *best_score {
                *best_score = score;
                best.clone_from(current);
            }
            return;
        }
        let mut placed = false;
        for speaker in 0..speakers {
            if used[speaker] {
                continue;
            }
            placed = true;
            used[speaker] = true;
            current[index] = Some(speaker);
            let gain = similarities[index][speaker];
            search(
                index + 1,
                similarities,
                speakers,
                used,
                current,
                score + gain,
                best,
                best_score,
            );
            used[speaker] = false;
        }
        if !placed {
            // More local speakers than global ones: reuse the closest.
            let closest = (0..speakers)
                .max_by(|&a, &b| similarities[index][a].total_cmp(&similarities[index][b]));
            current[index] = closest;
            let gain = closest.map_or(0.0, |speaker| similarities[index][speaker]);
            search(
                index + 1,
                similarities,
                speakers,
                used,
                current,
                score + gain,
                best,
                best_score,
            );
        }
        current[index] = None;
    }
    let mut used = vec![false; speakers];
    search(
        0,
        similarities,
        speakers,
        &mut used,
        &mut current,
        0.0,
        &mut best,
        &mut best_score,
    );
    best
}

pub fn diarize(
    segmentation: &mut Segmentation,
    embedders: &mut [Embedder],
    audio: &[f32],
    options: &Options,
) -> Result<Diarization> {
    if audio.len() < SAMPLE_RATE / 2 {
        return Ok(Diarization::default());
    }
    let window_samples = segmentation.window;
    let step = ((options.step_seconds * SAMPLE_RATE as f32) as usize)
        .clamp(segmentation.frame_shift, window_samples);
    let (windows, frames) = segment(segmentation, audio, step)?;
    let frame_shift = segmentation.frame_shift;
    let offset = |window: &Window| (window.start as f32 / frame_shift as f32 + 0.5) as usize;
    let total_frames = offset(windows.last().unwrap()) + frames;
    let audio_frames = (audio.len() / frame_shift).min(total_frames);

    // How many speakers talk in each frame, averaged over the windows.
    let mut count_sum = vec![0f32; total_frames];
    let mut coverage = vec![0f32; total_frames];
    for window in &windows {
        let first = offset(window);
        for (frame, mask) in window.masks.iter().enumerate() {
            count_sum[first + frame] += mask.count_ones() as f32;
            coverage[first + frame] += 1.0;
        }
    }
    let counts: Vec<usize> = count_sum
        .iter()
        .zip(&coverage)
        .map(|(sum, covered)| {
            if *covered > 0.0 {
                (sum / covered + 0.5) as usize
            } else {
                0
            }
        })
        .collect();
    if counts.iter().all(|&count| count == 0) {
        return Ok(Diarization::default());
    }

    // Embed each local speaker that said enough in a window.
    let min_clean = (options.min_clean_seconds * SAMPLE_RATE as f32) as usize;
    let mut locals = Vec::new();
    let mut jobs = Vec::new();
    for (index, window) in windows.iter().enumerate() {
        for speaker in 0..segmentation.speakers {
            if !window.masks.iter().any(|mask| mask & (1 << speaker) != 0) {
                continue;
            }
            let (runs, clean) = local_runs(audio.len(), window, window_samples, speaker, min_clean);
            let embeddable = run_samples(&runs) >= MIN_EMBEDDING_SAMPLES;
            locals.push(Local {
                window: index,
                speaker,
                clean,
                embedding: None,
            });
            if embeddable {
                jobs.push((locals.len() - 1, runs));
            }
        }
    }
    let embeddings = embed_all(embedders, jobs.len(), |index| gather(audio, &jobs[index].1))?;
    for ((target, _), embedding) in jobs.iter().zip(embeddings) {
        let target = *target;
        locals[target].embedding = Some(embedding);
    }

    // Cluster the clean embeddings into speakers.
    let mut training: Vec<usize> = (0..locals.len())
        .filter(|&i| locals[i].clean && locals[i].embedding.is_some())
        .collect();
    if training.len() < 2 {
        training = (0..locals.len())
            .filter(|&i| locals[i].embedding.is_some())
            .collect();
    }
    if training.len() > MAX_CLUSTERED {
        let stride = training.len().div_ceil(MAX_CLUSTERED);
        training = training.into_iter().step_by(stride).collect();
    }
    let vectors: Vec<Vec<f32>> = training
        .iter()
        .map(|&i| locals[i].embedding.clone().unwrap())
        .collect();
    let merges = cluster::dendrogram(&vectors);
    let labels = cluster::cut(
        vectors.len(),
        &merges,
        options.threshold,
        options.min_speakers,
        options.max_speakers,
    );
    let clusters = labels.iter().copied().max().map_or(0, |max| max + 1);
    let mut sizes = vec![0usize; clusters];
    for &label in &labels {
        sizes[label] += 1;
    }
    // A short recording has few windows; a fixed minimum would merge everyone.
    let min_size = options
        .min_cluster_size
        .min(((vectors.len() as f32 * 0.1).round() as usize).max(1));
    let mut keep: Vec<usize> = (0..clusters).filter(|&c| sizes[c] >= min_size).collect();
    if keep.len() < options.min_speakers.min(clusters) || keep.is_empty() {
        // Too few large clusters: keep the largest ones instead.
        let mut by_size: Vec<usize> = (0..clusters).collect();
        by_size.sort_by_key(|&c| std::cmp::Reverse(sizes[c]));
        keep = by_size
            .into_iter()
            .take(options.min_speakers.max(1).min(clusters))
            .collect();
        keep.sort();
    }
    let centroids: Vec<Vec<f32>> = keep
        .iter()
        .map(|&cluster| {
            let mut sum = vec![0f32; vectors.first().map_or(0, Vec::len)];
            for (vector, _) in vectors
                .iter()
                .zip(&labels)
                .filter(|(_, label)| **label == cluster)
            {
                for (total, value) in sum.iter_mut().zip(vector) {
                    *total += value;
                }
            }
            normalized(sum)
        })
        .collect();
    let speakers = centroids.len();
    if speakers == 0 {
        return Ok(Diarization::default());
    }

    // Map each window's local speakers to distinct global speakers.
    let mut global: Vec<Option<usize>> = vec![None; locals.len()];
    let mut by_window: Vec<Vec<usize>> = vec![Vec::new(); windows.len()];
    for (index, local) in locals.iter().enumerate() {
        if local.embedding.is_some() {
            by_window[local.window].push(index);
        }
    }
    for members in &by_window {
        let similarities: Vec<Vec<f32>> = members
            .iter()
            .map(|&i| {
                centroids
                    .iter()
                    .map(|c| cosine(locals[i].embedding.as_ref().unwrap(), c))
                    .collect()
            })
            .collect();
        for (&member, speaker) in members.iter().zip(assign(&similarities, speakers)) {
            global[member] = speaker;
        }
    }

    // Average each speaker's activity per frame over the windows.
    let mut activity = vec![0f32; total_frames * speakers];
    for (index, local) in locals.iter().enumerate() {
        let Some(speaker) = global[index] else {
            continue;
        };
        let window = &windows[local.window];
        let first = offset(window);
        for (frame, mask) in window.masks.iter().enumerate() {
            if mask & (1 << local.speaker) != 0 {
                activity[(first + frame) * speakers + speaker] += 1.0;
            }
        }
    }
    let mut active = vec![false; total_frames * speakers];
    let mut order: Vec<usize> = (0..speakers).collect();
    for frame in 0..audio_frames {
        if counts[frame] == 0 || coverage[frame] == 0.0 {
            continue;
        }
        let row = &activity[frame * speakers..(frame + 1) * speakers];
        order.sort_by(|&a, &b| row[b].total_cmp(&row[a]));
        for &speaker in order.iter().take(counts[frame]) {
            if row[speaker] > 0.0 {
                active[frame * speakers + speaker] = true;
            }
        }
    }

    // Frames to turns.
    let half_frame = segmentation.frame_size / 2;
    let center_ms = |frame: usize| ((frame * frame_shift + half_frame) * 1000 / SAMPLE_RATE) as u64;
    let half_shift_ms = (frame_shift * 500 / SAMPLE_RATE) as u64;
    let audio_ms = (audio.len() * 1000 / SAMPLE_RATE) as u64;
    let mut turns: Vec<Turn> = Vec::new();
    for speaker in 0..speakers {
        let mut run: Option<usize> = None;
        let mut own: Vec<Turn> = Vec::new();
        for frame in 0..=audio_frames {
            let on = frame < audio_frames && active[frame * speakers + speaker];
            match (on, run) {
                (true, None) => run = Some(frame),
                (false, Some(first)) => {
                    let start_ms = center_ms(first).saturating_sub(half_shift_ms);
                    let end_ms = (center_ms(frame - 1) + half_shift_ms).min(audio_ms);
                    let gap_ms = (options.min_gap_seconds * 1000.0) as u64;
                    match own.last_mut() {
                        Some(last) if start_ms <= last.end_ms + gap_ms => last.end_ms = end_ms,
                        _ => own.push(Turn {
                            start_ms,
                            end_ms,
                            speaker,
                        }),
                    }
                    run = None;
                }
                _ => {}
            }
        }
        let min_ms = (options.min_turn_seconds * 1000.0) as u64;
        turns.extend(
            own.into_iter()
                .filter(|turn| turn.end_ms - turn.start_ms >= min_ms),
        );
    }
    turns.sort_by_key(|turn| (turn.start_ms, turn.speaker));

    // Number speakers in order of first appearance.
    let mut renumber = vec![usize::MAX; speakers];
    let mut next = 0;
    for turn in &turns {
        if renumber[turn.speaker] == usize::MAX {
            renumber[turn.speaker] = next;
            next += 1;
        }
    }
    let mut summaries: Vec<Speaker> = (0..speakers)
        .filter(|&s| renumber[s] != usize::MAX)
        .map(|s| Speaker {
            speaker: renumber[s],
            speech_ms: turns
                .iter()
                .filter(|t| t.speaker == s)
                .map(|t| t.end_ms - t.start_ms)
                .sum(),
            embedding: centroids[s].clone(),
        })
        .collect();
    summaries.sort_by_key(|speaker| speaker.speaker);
    for turn in turns.iter_mut() {
        turn.speaker = renumber[turn.speaker];
    }
    Ok(Diarization {
        turns,
        speakers: summaries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignment_keeps_local_speakers_apart() {
        // Both locals prefer speaker 0; the better total puts one on 1.
        let similarities = vec![vec![0.9, 0.2], vec![0.8, 0.7]];
        assert_eq!(assign(&similarities, 2), vec![Some(0), Some(1)]);
        // More locals than speakers: the extra one reuses its closest.
        let crowded = vec![vec![0.9], vec![0.5]];
        assert_eq!(assign(&crowded, 1), vec![Some(0), Some(0)]);
    }
}
