//! The two ONNX models: pyannote segmentation 3.0 (who is talking in each
//! frame of a 10 s window, up to three local speakers) and a speaker
//! embedding model (a fixed-length voice vector for a stretch of speech).
//! Both read their settings from the model's own metadata, as exported for
//! sherpa-onnx.

use crate::fbank::Fbank;
use ort::environment::Environment;
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::Tensor;
use std::path::Path;

pub type Result<T> = std::result::Result<T, String>;

fn err(context: &str) -> impl Fn(ort::Error) -> String + '_ {
    move |error| format!("{context}: {error}")
}

pub fn session(env: &Environment, path: &Path, threads: usize) -> Result<Session> {
    Session::builder(env)
        .map_err(err("session"))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|error| format!("session: {error}"))?
        .with_intra_threads(threads)
        .map_err(|error| format!("session: {error}"))?
        .with_inter_threads(1)
        .map_err(|error| format!("session: {error}"))?
        .commit_from_file(path)
        .map_err(|error| format!("loading {}: {error}", path.display()))
}

fn meta(session: &Session, key: &str) -> Option<String> {
    session.metadata().ok()?.custom(key)
}

fn meta_usize(session: &Session, key: &str) -> Result<usize> {
    meta(session, key)
        .and_then(|value| value.trim().parse().ok())
        .ok_or_else(|| format!("the segmentation model has no `{key}` metadata"))
}

pub struct Segmentation {
    session: Session,
    /// Samples per window (10 s).
    pub window: usize,
    /// Samples between the starts of consecutive output frames.
    pub frame_shift: usize,
    /// Samples one output frame covers.
    pub frame_size: usize,
    /// Local speakers per window.
    pub speakers: usize,
    /// Powerset class to the local speakers it switches on.
    powerset: Vec<Vec<usize>>,
}

impl Segmentation {
    pub fn load(env: &Environment, path: &Path, threads: usize) -> Result<Self> {
        let session = session(env, path, threads)?;
        let window = meta_usize(&session, "window_size")?;
        let frame_size = meta_usize(&session, "receptive_field_size")?;
        let frame_shift = meta_usize(&session, "receptive_field_shift")?;
        let speakers = meta_usize(&session, "num_speakers")?;
        let max_classes = meta_usize(&session, "powerset_max_classes")?;
        let classes = meta_usize(&session, "num_classes")?;
        let mut powerset = vec![Vec::new()];
        for speaker in 0..speakers {
            powerset.push(vec![speaker]);
        }
        if max_classes >= 2 {
            for first in 0..speakers {
                for second in first + 1..speakers {
                    powerset.push(vec![first, second]);
                }
            }
        }
        if powerset.len() != classes {
            return Err(format!(
                "unsupported powerset: {classes} classes for {speakers} speakers"
            ));
        }
        Ok(Self {
            session,
            window,
            frame_shift,
            frame_size,
            speakers,
            powerset,
        })
    }

    /// Runs a batch of windows (`batch * window` samples) and returns, per
    /// window and frame, which local speakers are active as a bitmask, plus
    /// the number of frames per window.
    pub fn activity(&mut self, samples: Vec<f32>, batch: usize) -> Result<(Vec<u8>, usize)> {
        let input = Tensor::from_array(([batch, 1, self.window], samples)).map_err(err("input"))?;
        let outputs = self
            .session
            .run(ort::inputs![input])
            .map_err(err("segmentation"))?;
        let (shape, scores) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(err("segmentation output"))?;
        let (frames, classes) = (shape[1] as usize, shape[2] as usize);
        let mut masks = Vec::with_capacity(batch * frames);
        for row in scores.chunks_exact(classes) {
            let best = row
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map(|(class, _)| class)
                .unwrap_or(0);
            masks.push(
                self.powerset[best]
                    .iter()
                    .fold(0u8, |mask, speaker| mask | (1 << speaker)),
            );
        }
        Ok((masks, frames))
    }
}

pub struct Embedder {
    session: Session,
    fbank: Fbank,
    /// Feed samples in the 16-bit integer range, as Kaldi tools do.
    scale_samples: bool,
    /// Subtract each feature dimension's mean over the utterance.
    subtract_mean: bool,
}

/// Shortest audio an embedding is computed for.
pub const MIN_EMBEDDING_SAMPLES: usize = 400 + 160 * 20;

impl Embedder {
    pub fn load(env: &Environment, path: &Path, threads: usize) -> Result<Self> {
        let session = session(env, path, threads)?;
        let sample_rate = meta(&session, "sample_rate")
            .and_then(|v| v.parse().ok())
            .unwrap_or(16_000);
        if sample_rate != 16_000 {
            return Err(format!(
                "the embedding model expects {sample_rate} Hz audio, not 16 kHz"
            ));
        }
        let scale_samples = meta(&session, "normalize_samples").as_deref() == Some("0");
        let subtract_mean =
            meta(&session, "feature_normalize_type").as_deref() == Some("global-mean");
        let fbank = Fbank::new(16_000, 80);
        Ok(Self {
            session,
            fbank,
            scale_samples,
            subtract_mean,
        })
    }

    fn run(
        session: &mut Session,
        fbank: &Fbank,
        scale_samples: bool,
        subtract_mean: bool,
        samples: &[f32],
    ) -> Result<Vec<f32>> {
        let mut features = if scale_samples {
            let scaled: Vec<f32> = samples.iter().map(|sample| sample * 32_768.0).collect();
            fbank.compute(&scaled)
        } else {
            fbank.compute(samples)
        };
        let bins = fbank.bins();
        let frames = features.len() / bins;
        if frames == 0 {
            return Err("too little audio for an embedding".into());
        }
        if subtract_mean {
            let mut means = vec![0f32; bins];
            for row in features.chunks_exact(bins) {
                for (mean, value) in means.iter_mut().zip(row) {
                    *mean += value;
                }
            }
            for mean in means.iter_mut() {
                *mean /= frames as f32;
            }
            for row in features.chunks_exact_mut(bins) {
                for (value, mean) in row.iter_mut().zip(&means) {
                    *value -= mean;
                }
            }
        }
        let input = Tensor::from_array(([1, frames, bins], features)).map_err(err("input"))?;
        let outputs = session.run(ort::inputs![input]).map_err(err("embedding"))?;
        let (_, values) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(err("embedding output"))?;
        Ok(normalized(values.to_vec()))
    }

    /// A unit-length voice vector for `samples` (16 kHz mono).
    pub fn embed(&mut self, samples: &[f32]) -> Result<Vec<f32>> {
        Self::run(
            &mut self.session,
            &self.fbank,
            self.scale_samples,
            self.subtract_mean,
            samples,
        )
    }
}

pub fn normalized(mut vector: Vec<f32>) -> Vec<f32> {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in vector.iter_mut() {
            *value /= norm;
        }
    }
    vector
}

pub fn cosine(left: &[f32], right: &[f32]) -> f32 {
    left.iter().zip(right).map(|(a, b)| a * b).sum()
}

/// Model metadata, for checking a model before use.
pub fn describe(env: &Environment, path: &Path) -> Result<serde_json::Value> {
    let session = session(env, path, 1)?;
    let metadata = session.metadata().map_err(err("metadata"))?;
    let keys = metadata.custom_keys().map_err(err("metadata"))?;
    let custom: serde_json::Map<String, serde_json::Value> = keys
        .into_iter()
        .map(|key| {
            let value = metadata.custom(&key).unwrap_or_default();
            (key, serde_json::Value::String(value))
        })
        .collect();
    let names = |outlets: &[ort::value::Outlet]| -> Vec<String> {
        outlets
            .iter()
            .map(|outlet| format!("{} {:?}", outlet.name(), outlet.dtype()))
            .collect()
    };
    Ok(serde_json::json!({
        "inputs": names(session.inputs()),
        "outputs": names(session.outputs()),
        "metadata": custom,
    }))
}
