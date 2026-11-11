//! `opengeni-speakers`: speaker diarization and voice embeddings for meeting
//! recordings, on CPU through ONNX Runtime.
//!
//! Audio arrives on stdin as 16 kHz mono 32-bit float little-endian PCM
//! (`ffmpeg -f f32le -ac 1 -ar 16000 -`). Results are JSON on stdout;
//! failures are a JSON `{"error": ...}` line on stderr and exit code 1.
//!
//! ```text
//! opengeni-speakers diarize --models DIR [--threads N] [--min-speakers N]
//!     [--max-speakers N] [--threshold D] [--merge-threshold D] [--step S]
//!     < audio.f32
//! opengeni-speakers embed --models DIR --segments FILE < audio.f32
//! opengeni-speakers align --models DIR --words FILE [--threads N] < audio.f32
//! opengeni-speakers align-serve --models DIR [--threads N] [--sessions N]
//! opengeni-speakers describe MODEL.onnx
//! ```
//!
//! `--models DIR` holds `segmentation.onnx` (pyannote segmentation 3.0) and
//! `embedding.onnx` (a speaker-embedding model exported for sherpa-onnx);
//! `--segmentation` and `--embedding` name the files directly instead.
//! `align` reads `alignment.onnx` (Omnilingual ASR CTC) and
//! `alignment-tokens.txt` from the same directory, and a JSON array of the
//! transcript's words from `--words`.
//!
//! `diarize` and `embed` use [`SPEAKER_THREADS`] threads unless `--threads`
//! says otherwise (fewer on a smaller machine); `align` uses every core.

// Frame and speaker arithmetic reads more clearly with explicit indices.
#![allow(clippy::needless_range_loop, clippy::too_many_arguments)]

mod align;
mod cluster;
mod diarize;
mod fbank;
mod models;

use diarize::{Options, SAMPLE_RATE};
use models::{Embedder, Result, Segmentation, normalized};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
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
        .ok_or("usage: opengeni-speakers diarize|embed|align|align-serve|describe ...")?;
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
    /// `--threads`, else `default` capped at the machine's cores.
    fn threads(&self, default: usize) -> Result<usize> {
        let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
        Ok(self.get("threads")?.unwrap_or(default.min(cores)).max(1))
    }
}

/// Speaker detection's threads when `--threads` is not given. More threads
/// finish a meeting little sooner but cost much more CPU and memory: on a
/// 30 minute meeting, 4 threads take 47 s and 128 CPU-seconds, all 32 threads
/// 21 s and 304 CPU-seconds. It runs alongside a transcription provider that
/// takes about as long, so the extra speed rarely shows.
const SPEAKER_THREADS: usize = 4;

fn read_audio(args: &Args) -> Result<Vec<f32>> {
    match args.values.get("input") {
        Some(path) => {
            let file =
                std::fs::File::open(path).map_err(|error| format!("reading {path}: {error}"))?;
            decode_pcm(file).map_err(|error| format!("reading {path}: {error}"))
        }
        None => decode_pcm(std::io::stdin().lock()),
    }
}

/// Decode 32-bit float PCM as it arrives, so the raw bytes are never held
/// next to the samples.
fn decode_pcm(mut input: impl Read) -> Result<Vec<f32>> {
    let mut samples = Vec::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut held = 0;
    loop {
        let read = match input.read(&mut buffer[held..]) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(format!("reading audio: {error}")),
        };
        let filled = held + read;
        let whole = filled - filled % 4;
        samples.extend(
            buffer[..whole]
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
        );
        buffer.copy_within(whole..filled, 0);
        held = filled - whole;
    }
    if held != 0 {
        return Err("the audio is not 32-bit float PCM".into());
    }
    Ok(samples)
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
    windows: usize,
    #[serde(rename = "reusedWindows")]
    reused_windows: usize,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
}

fn run_diarize(args: &Args) -> Result<String> {
    let started = Instant::now();
    let threads = args.threads(SPEAKER_THREADS)?;
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
        merge_threshold: args
            .get("merge-threshold")?
            .unwrap_or(defaults.merge_threshold),
        min_speakers: args.get("min-speakers")?.unwrap_or(defaults.min_speakers),
        max_speakers: args.get("max-speakers")?.unwrap_or(defaults.max_speakers),
        min_cluster_size: args
            .get("min-cluster-size")?
            .unwrap_or(defaults.min_cluster_size),
        min_clean_seconds: args.get("min-clean")?.unwrap_or(defaults.min_clean_seconds),
        min_turn_seconds: args.get("min-turn")?.unwrap_or(defaults.min_turn_seconds),
        min_gap_seconds: args.get("min-gap")?.unwrap_or(defaults.min_gap_seconds),
    };
    // A growing recording is scanned as it arrives (`--scan-only`), keeping
    // its windows in `--cache-out`; a later run takes them from `--cache-in`
    // and only scans what is new.
    let fingerprint = cache_fingerprint(args, &segmentation, &options)?;
    let cache = match args.values.get("cache-in") {
        Some(path) => match std::fs::read(path) {
            Ok(bytes) => diarize::WindowCache::read(&bytes, fingerprint),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("reading {path}: {error}")),
        },
        None => None,
    };
    let scanned = diarize::scan(
        &mut segmentation,
        &mut embedders,
        &audio,
        &options,
        cache.as_ref(),
    )?;
    let (windows, reused) = (scanned.windows(), scanned.reused);
    if let Some(path) = args.values.get("cache-out") {
        let kept = diarize::WindowCache::of(&scanned, segmentation.window, audio.len());
        std::fs::write(path, kept.write(fingerprint, audio.len() as u64))
            .map_err(|error| format!("writing {path}: {error}"))?;
    }
    let audio_ms = (audio.len() * 1000 / SAMPLE_RATE) as u64;
    if args.values.get("scan-only").map(String::as_str) == Some("true") {
        return serde_json::to_string(&ScanOutput {
            audio_ms,
            windows,
            reused_windows: reused,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
        .map_err(|e| e.to_string());
    }
    let result = diarize::diarize_scanned(&segmentation, &audio, &options, scanned)?;
    let output = DiarizeOutput {
        result: &result,
        audio_ms,
        windows,
        reused_windows: reused,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    serde_json::to_string(&output).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct ScanOutput {
    #[serde(rename = "audioMs")]
    audio_ms: u64,
    windows: usize,
    #[serde(rename = "reusedWindows")]
    reused_windows: usize,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
}

/// What a window's scan depends on: both models and the settings that shape
/// windows and embeddings. A cache made under anything else is not reused.
fn cache_fingerprint(args: &Args, segmentation: &Segmentation, options: &Options) -> Result<u64> {
    const VERSION: u64 = 1;
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    let mut add = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    add(&VERSION.to_le_bytes());
    for name in ["segmentation", "embedding"] {
        let path = args.model(name)?;
        let bytes =
            std::fs::read(&path).map_err(|error| format!("reading {}: {error}", path.display()))?;
        add(&(bytes.len() as u64).to_le_bytes());
        // The ends of a model file tell versions apart without hashing it whole.
        let edge = bytes.len().min(1 << 20);
        add(&bytes[..edge]);
        add(&bytes[bytes.len() - edge..]);
    }
    for value in [
        segmentation.window,
        segmentation.frame_shift,
        segmentation.speakers,
        models::MIN_EMBEDDING_SAMPLES,
    ] {
        add(&(value as u64).to_le_bytes());
    }
    add(&options.step_seconds.to_le_bytes());
    add(&options.min_clean_seconds.to_le_bytes());
    Ok(hash)
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
    let threads = args.threads(SPEAKER_THREADS)?;
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
        let vectors = diarize::embed_all(&mut embedders, jobs.len(), |index| &jobs[index])?;
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

#[derive(Serialize)]
struct AlignOutput {
    #[serde(flatten)]
    result: align::Alignment,
    #[serde(rename = "elapsedMs")]
    elapsed_ms: u64,
}

/// The aligner's model and vocabulary, from `--models` or named directly.
fn load_aligner(args: &Args, env: &ort::environment::Environment) -> Result<align::Aligner> {
    load_aligner_with(args, env, args.threads(usize::MAX)?)
}

fn load_aligner_with(
    args: &Args,
    env: &ort::environment::Environment,
    threads: usize,
) -> Result<align::Aligner> {
    let model = args.model("alignment")?;
    let tokens = match args.values.get("tokens") {
        Some(path) => PathBuf::from(path),
        None => model.with_file_name("alignment-tokens.txt"),
    };
    align::Aligner::load(env, &model, &tokens, threads)
}

fn environment() -> Result<ort::environment::Environment> {
    ort::init()
        .with_name("opengeni-speakers")
        .build()
        .map_err(|e| e.to_string())
}

fn open(path: &str) -> Result<std::fs::File> {
    std::fs::File::open(path).map_err(|error| format!("reading {path}: {error}"))
}

/// Word timings for a transcript that came without them.
fn run_align(args: &Args) -> Result<String> {
    let started = Instant::now();
    let file = args.values.get("words").ok_or("--words FILE is needed")?;
    let words: Vec<String> = serde_json::from_slice(
        &std::fs::read(file).map_err(|error| format!("reading {file}: {error}"))?,
    )
    .map_err(|error| format!("{file}: {error}"))?;
    let env = environment()?;
    let aligner = load_aligner(args, &env)?;
    let result = match args.values.get("input") {
        Some(path) => aligner.align(open(path)?, &words)?,
        None => aligner.align(std::io::stdin().lock(), &words)?,
    };
    let output = AlignOutput {
        result,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    serde_json::to_string(&output).map_err(|e| e.to_string())
}

/// One request to `align-serve`: a transcript's words and the audio they
/// were heard in, as 16 kHz mono f32 PCM: a file (`input`), or what a
/// decoder writes to its stdout (`decode`, its command line), so no decoded
/// copy of the audio is written to disk.
#[derive(Deserialize)]
struct AlignRequest {
    words: Vec<String>,
    input: Option<String>,
    decode: Option<Vec<String>>,
}

fn align_request(aligner: &align::Aligner, request: AlignRequest) -> Result<align::Alignment> {
    match (request.input, request.decode) {
        (Some(path), None) => aligner.align(open(&path)?, &request.words),
        (None, Some(command)) => {
            let (program, arguments) = command.split_first().ok_or("decode: no command")?;
            let mut child = std::process::Command::new(program)
                .args(arguments)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .map_err(|error| format!("decode: {program}: {error}"))?;
            let stdout = child.stdout.take().ok_or("decode: no stdout")?;
            let mut stderr = child.stderr.take().ok_or("decode: no stderr")?;
            let errors = std::thread::spawn(move || {
                let mut text = String::new();
                let _ = stderr.read_to_string(&mut text);
                text
            });
            let aligned = aligner.align(stdout, &request.words);
            // Reading stops early only on a failure; the decoder is not needed then.
            if aligned.is_err() {
                let _ = child.kill();
            }
            let status = child.wait().map_err(|error| format!("decode: {error}"))?;
            let errors = errors.join().unwrap_or_default();
            let aligned = aligned?;
            if !status.success() {
                let tail: String = errors.trim().chars().rev().take(400).collect();
                let tail: String = tail.chars().rev().collect();
                return Err(format!("the decoder failed ({status}): {tail}"));
            }
            Ok(aligned)
        }
        _ => Err("give either input or decode".into()),
    }
}

/// The fewest threads an `align-serve` copy of the model gets.
const SERVE_THREADS_PER_SESSION: usize = 4;

/// Word timings for many transcripts from models loaded once, so a worker
/// holds a fixed number of copies however many pieces it aligns. Each line
/// on stdin is a JSON request `{"id", "words", "input" or "decode"}`; each
/// answer is a JSON line with the same `id` and the alignment or an
/// `error`, in the order they finish. `--sessions N` loads N copies that
/// align N pieces at once, sharing the threads: one copy at a time keeps
/// memory low, and a few copies get more from a large machine (4 copies of
/// 4 threads align about 20% more than one of 16), up to one copy for each
/// 4 threads. A `{"ready": true, "sessions": N}` line says how many copies
/// are loaded. It ends when stdin does, after answering
/// everything it was asked.
fn run_align_serve(args: &Args) -> Result<String> {
    let threads = args.threads(usize::MAX)?;
    // More copies than a quarter of the threads only take memory.
    let sessions = args
        .get::<usize>("sessions")?
        .unwrap_or(1)
        .clamp(1, (threads / SERVE_THREADS_PER_SESSION).max(1));
    let threads = (threads / sessions).max(1);
    let env = environment()?;
    let mut aligners = Vec::with_capacity(sessions);
    for _ in 0..sessions {
        aligners.push(load_aligner_with(args, &env, threads)?);
    }
    let stdout = std::sync::Mutex::new(std::io::stdout());
    let answer = |line: serde_json::Value| {
        if let Ok(mut out) = stdout.lock() {
            // A closed stdout means the caller is gone; stdin ends next.
            let _ = writeln!(out, "{line}").and_then(|()| out.flush());
        }
    };
    answer(serde_json::json!({ "ready": true, "sessions": sessions }));
    let (send, receive) = std::sync::mpsc::sync_channel::<(serde_json::Value, String)>(0);
    let receive = std::sync::Mutex::new(receive);
    std::thread::scope(|scope| {
        for aligner in &aligners {
            let (receive, answer) = (&receive, &answer);
            scope.spawn(move || {
                loop {
                    let next = match receive.lock() {
                        Ok(receiver) => receiver.recv(),
                        Err(_) => return,
                    };
                    let Ok((id, line)) = next else { return };
                    let started = Instant::now();
                    let result = serde_json::from_str::<AlignRequest>(&line)
                        .map_err(|error| format!("bad request: {error}"))
                        .and_then(|request| align_request(aligner, request));
                    answer(match result {
                        Ok(result) => {
                            let mut value = serde_json::to_value(AlignOutput {
                                result,
                                elapsed_ms: started.elapsed().as_millis() as u64,
                            })
                            .unwrap_or_default();
                            value["id"] = id;
                            value
                        }
                        Err(error) => serde_json::json!({ "id": id, "error": error }),
                    });
                }
            });
        }
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let id = serde_json::from_str::<serde_json::Value>(&line)
                .ok()
                .and_then(|value| value.get("id").cloned())
                .unwrap_or(serde_json::Value::Null);
            if send.send((id, line)).is_err() {
                break;
            }
        }
        drop(send);
    });
    Ok(serde_json::json!({ "done": true }).to_string())
}

fn run() -> Result<String> {
    let args = parse_args()?;
    match args.command.as_str() {
        "diarize" => run_diarize(&args),
        "embed" => run_embed(&args),
        "align" => run_align(&args),
        "align-serve" => run_align_serve(&args),
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
