//! `opengeni-speakers`: speaker diarization and voice embeddings for meeting
//! recordings, on CPU through ONNX Runtime.
//!
//! Audio arrives on stdin as 16 kHz mono 32-bit float little-endian PCM
//! (`ffmpeg -f f32le -ac 1 -ar 16000 -`). Results are JSON on stdout;
//! failures are a JSON `{"error": ...}` line on stderr and exit code 1.
//!
//! ```text
//! opengeni-speakers diarize --models DIR [--threads N] [--min-speakers N]
//!     [--max-speakers N] [--threshold D] [--step S] < audio.f32
//! opengeni-speakers embed --models DIR --segments FILE < audio.f32
//! opengeni-speakers describe MODEL.onnx
//! ```
//!
//! `--models DIR` holds `segmentation.onnx` (pyannote segmentation 3.0) and
//! `embedding.onnx` (a speaker-embedding model exported for sherpa-onnx);
//! `--segmentation` and `--embedding` name the files directly instead.

// Frame and speaker arithmetic reads more clearly with explicit indices.
#![allow(clippy::needless_range_loop, clippy::too_many_arguments)]

mod cluster;
mod diarize;
mod fbank;
mod models;

use diarize::{Options, SAMPLE_RATE};
use models::{Embedder, Result, Segmentation, normalized};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Instant;

struct Args {
    command: String,
    values: HashMap<String, String>,
    positional: Vec<String>,
}

fn parse_args() -> Result<Args> {
    let mut raw = std::env::args().skip(1);
    let command = raw
        .next()
        .ok_or("usage: opengeni-speakers diarize|embed|describe ...")?;
    let mut values = HashMap::new();
    let mut positional = Vec::new();
    while let Some(arg) = raw.next() {
        if let Some(name) = arg.strip_prefix("--") {
            let value = raw.next().ok_or(format!("--{name} needs a value"))?;
            values.insert(name.to_string(), value);
        } else {
            positional.push(arg);
        }
    }
    Ok(Args {
        command,
        values,
        positional,
    })
}

impl Args {
    fn get<T: std::str::FromStr>(&self, name: &str) -> Result<Option<T>> {
        self.values
            .get(name)
            .map(|value| {
                value
                    .parse()
                    .map_err(|_| format!("--{name}: can't read {value:?}"))
            })
            .transpose()
    }
    fn model(&self, name: &str) -> Result<PathBuf> {
        if let Some(path) = self.values.get(name) {
            return Ok(PathBuf::from(path));
        }
        let dir = self
            .values
            .get("models")
            .cloned()
            .or_else(|| std::env::var("OPENGENI_SPEAKER_MODELS").ok())
            .ok_or(format!("give --models DIR or --{name} FILE"))?;
        Ok(PathBuf::from(dir).join(format!("{name}.onnx")))
    }
    fn threads(&self) -> Result<usize> {
        Ok(self
            .get("threads")?
            .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
            .max(1))
    }
}

fn read_audio(args: &Args) -> Result<Vec<f32>> {
    let mut bytes = Vec::new();
    match args.values.get("input") {
        Some(path) => {
            bytes = std::fs::read(path).map_err(|error| format!("reading {path}: {error}"))?;
        }
        None => {
            std::io::stdin()
                .read_to_end(&mut bytes)
                .map_err(|error| format!("reading audio: {error}"))?;
        }
    }
    if bytes.len() % 4 != 0 {
        return Err("the audio is not 32-bit float PCM".into());
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect())
}

fn embedders(
    env: &ort::environment::Environment,
    args: &Args,
    threads: usize,
) -> Result<Vec<Embedder>> {
    let path = args.model("embedding")?;
    (0..threads)
        .map(|_| Embedder::load(env, &path, 1))
        .collect()
}

#[derive(Serialize)]
struct DiarizeOutput<'a> {
    #[serde(flatten)]
    result: &'a diarize::Diarization,
    #[serde(rename = "audioMs")]
    audio_ms: u64,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
}

fn run_diarize(args: &Args) -> Result<String> {
    let started = Instant::now();
    let threads = args.threads()?;
    let env = ort::init()
        .with_name("opengeni-speakers")
        .build()
        .map_err(|e| e.to_string())?;
    let mut segmentation = Segmentation::load(&env, &args.model("segmentation")?, threads)?;
    let mut embedders = embedders(&env, args, threads)?;
    let audio = read_audio(args)?;
    let defaults = Options::default();
    let options = Options {
        step_seconds: args.get("step")?.unwrap_or(defaults.step_seconds),
        threshold: args.get("threshold")?.unwrap_or(defaults.threshold),
        min_speakers: args.get("min-speakers")?.unwrap_or(defaults.min_speakers),
        max_speakers: args.get("max-speakers")?.unwrap_or(defaults.max_speakers),
        min_cluster_size: args
            .get("min-cluster-size")?
            .unwrap_or(defaults.min_cluster_size),
        min_clean_seconds: args.get("min-clean")?.unwrap_or(defaults.min_clean_seconds),
        min_turn_seconds: args.get("min-turn")?.unwrap_or(defaults.min_turn_seconds),
        min_gap_seconds: args.get("min-gap")?.unwrap_or(defaults.min_gap_seconds),
    };
    let result = diarize::diarize(&mut segmentation, &mut embedders, &audio, &options)?;
    let output = DiarizeOutput {
        result: &result,
        audio_ms: (audio.len() * 1000 / SAMPLE_RATE) as u64,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    serde_json::to_string(&output).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct Segment {
    label: String,
    #[serde(rename = "startMs")]
    start_ms: u64,
    #[serde(rename = "endMs")]
    end_ms: u64,
}

#[derive(Serialize)]
struct Voice {
    label: String,
    #[serde(rename = "speechMs")]
    speech_ms: u64,
    embedding: Vec<f32>,
}

/// One voice vector per label: its speech, in pieces of up to ten seconds,
/// embedded and averaged.
fn run_embed(args: &Args) -> Result<String> {
    let threads = args.threads()?;
    let file = args
        .values
        .get("segments")
        .ok_or("--segments FILE is needed")?;
    let segments: Vec<Segment> = serde_json::from_slice(
        &std::fs::read(file).map_err(|error| format!("reading {file}: {error}"))?,
    )
    .map_err(|error| format!("{file}: {error}"))?;
    let env = ort::init()
        .with_name("opengeni-speakers")
        .build()
        .map_err(|e| e.to_string())?;
    let mut embedders = embedders(&env, args, threads)?;
    let audio = read_audio(args)?;
    let to_sample = |ms: u64| ((ms as usize) * SAMPLE_RATE / 1000).min(audio.len());
    let mut labels: Vec<String> = Vec::new();
    let mut pieces: HashMap<String, Vec<Vec<f32>>> = HashMap::new();
    let mut speech: HashMap<String, u64> = HashMap::new();
    for segment in &segments {
        let (from, to) = (to_sample(segment.start_ms), to_sample(segment.end_ms));
        if from >= to {
            continue;
        }
        if !pieces.contains_key(&segment.label) {
            labels.push(segment.label.clone());
        }
        *speech.entry(segment.label.clone()).or_default() += segment.end_ms - segment.start_ms;
        let list = pieces.entry(segment.label.clone()).or_default();
        for chunk in audio[from..to].chunks(10 * SAMPLE_RATE) {
            match list.last_mut() {
                Some(last) if last.len() + chunk.len() <= 10 * SAMPLE_RATE => {
                    last.extend_from_slice(chunk)
                }
                _ => list.push(chunk.to_vec()),
            }
        }
    }
    let mut voices = Vec::new();
    for label in labels {
        let jobs: Vec<Vec<f32>> = pieces
            .remove(&label)
            .unwrap_or_default()
            .into_iter()
            .filter(|piece| piece.len() >= models::MIN_EMBEDDING_SAMPLES)
            .collect();
        if jobs.is_empty() {
            continue;
        }
        let weights: Vec<f32> = jobs.iter().map(|piece| piece.len() as f32).collect();
        let vectors = diarize::embed_all(&mut embedders, jobs)?;
        let mut sum = vec![0f32; vectors[0].len()];
        for (vector, weight) in vectors.iter().zip(&weights) {
            for (total, value) in sum.iter_mut().zip(vector) {
                *total += value * weight;
            }
        }
        voices.push(Voice {
            speech_ms: speech[&label],
            label,
            embedding: normalized(sum),
        });
    }
    serde_json::to_string(&voices).map_err(|e| e.to_string())
}

fn run() -> Result<String> {
    let args = parse_args()?;
    match args.command.as_str() {
        "diarize" => run_diarize(&args),
        "embed" => run_embed(&args),
        "describe" => {
            let path = args
                .positional
                .first()
                .ok_or("describe needs a model file")?;
            let env = ort::init().build().map_err(|e| e.to_string())?;
            Ok(models::describe(&env, std::path::Path::new(path))?.to_string())
        }
        other => Err(format!("unknown command {other:?}")),
    }
}

fn main() {
    match run() {
        Ok(json) => {
            let mut stdout = std::io::stdout().lock();
            let _ = writeln!(stdout, "{json}");
        }
        Err(message) => {
            eprintln!("{}", serde_json::json!({ "error": message }));
            std::process::exit(1);
        }
    }
}
