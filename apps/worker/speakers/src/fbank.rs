//! Kaldi-compatible log mel filterbank features, the input speaker-embedding
//! models (WeSpeaker, 3D-Speaker, NeMo TitaNet as exported for sherpa-onnx)
//! were trained on: 25 ms Povey-windowed frames every 10 ms, pre-emphasis
//! 0.97, a 512-point FFT and 80 mel bins from 20 Hz to Nyquist, no dither.

use rustfft::{Fft, FftPlanner, num_complex::Complex32};
use std::sync::Arc;

const FRAME_LENGTH: usize = 400;
const FRAME_SHIFT: usize = 160;
const PADDED: usize = 512;
const PREEMPHASIS: f32 = 0.97;
const LOW_HZ: f32 = 20.0;

pub struct Fbank {
    bins: usize,
    window: Vec<f32>,
    /// Per mel bin: the first FFT bin it covers and its weights.
    banks: Vec<(usize, Vec<f32>)>,
    fft: Arc<dyn Fft<f32>>,
}

fn mel(hz: f32) -> f32 {
    1127.0 * (1.0 + hz / 700.0).ln()
}

impl Fbank {
    pub fn new(sample_rate: u32, bins: usize) -> Self {
        let window = (0..FRAME_LENGTH)
            .map(|i| {
                let hann = 0.5
                    - 0.5
                        * (2.0 * std::f32::consts::PI * i as f32 / (FRAME_LENGTH - 1) as f32).cos();
                hann.powf(0.85)
            })
            .collect();
        let nyquist = sample_rate as f32 / 2.0;
        let (mel_low, mel_high) = (mel(LOW_HZ), mel(nyquist));
        let delta = (mel_high - mel_low) / (bins + 1) as f32;
        let fft_bin_width = sample_rate as f32 / PADDED as f32;
        let banks = (0..bins)
            .map(|bin| {
                let left = mel_low + bin as f32 * delta;
                let center = left + delta;
                let right = center + delta;
                let mut first = None;
                let mut weights = Vec::new();
                for fft_bin in 0..PADDED / 2 {
                    let m = mel(fft_bin_width * fft_bin as f32);
                    if m > left && m < right {
                        first.get_or_insert(fft_bin);
                        weights.push(if m <= center {
                            (m - left) / (center - left)
                        } else {
                            (right - m) / (right - center)
                        });
                    } else if first.is_some() {
                        break;
                    }
                }
                (first.unwrap_or(0), weights)
            })
            .collect();
        let fft = FftPlanner::new().plan_fft_forward(PADDED);
        Self {
            bins,
            window,
            banks,
            fft,
        }
    }

    pub fn bins(&self) -> usize {
        self.bins
    }

    /// Features for `samples`, row-major `[frames][bins]`. Fewer than one
    /// frame of audio gives no frames.
    pub fn compute(&self, samples: &[f32]) -> Vec<f32> {
        if samples.len() < FRAME_LENGTH {
            return Vec::new();
        }
        let frames = 1 + (samples.len() - FRAME_LENGTH) / FRAME_SHIFT;
        let mut out = Vec::with_capacity(frames * self.bins);
        let mut frame = [0f32; FRAME_LENGTH];
        let mut spectrum = vec![Complex32::new(0.0, 0.0); PADDED];
        let mut scratch = vec![Complex32::new(0.0, 0.0); self.fft.get_inplace_scratch_len()];
        let mut power = [0f32; PADDED / 2 + 1];
        for index in 0..frames {
            let start = index * FRAME_SHIFT;
            frame.copy_from_slice(&samples[start..start + FRAME_LENGTH]);
            let mean = frame.iter().sum::<f32>() / FRAME_LENGTH as f32;
            for value in frame.iter_mut() {
                *value -= mean;
            }
            for i in (1..FRAME_LENGTH).rev() {
                frame[i] -= PREEMPHASIS * frame[i - 1];
            }
            frame[0] -= PREEMPHASIS * frame[0];
            for (i, slot) in spectrum.iter_mut().enumerate() {
                *slot = if i < FRAME_LENGTH {
                    Complex32::new(frame[i] * self.window[i], 0.0)
                } else {
                    Complex32::new(0.0, 0.0)
                };
            }
            self.fft.process_with_scratch(&mut spectrum, &mut scratch);
            for (i, value) in power.iter_mut().enumerate() {
                *value = spectrum[i].norm_sqr();
            }
            for (first, weights) in &self.banks {
                let energy: f32 = weights
                    .iter()
                    .enumerate()
                    .map(|(i, weight)| weight * power[first + i])
                    .sum();
                out.push(energy.max(f32::EPSILON).ln());
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_count_follows_kaldi_snip_edges() {
        let fbank = Fbank::new(16_000, 80);
        assert!(fbank.compute(&[0.0; 399]).is_empty());
        assert_eq!(fbank.compute(&[0.0; 400]).len(), 80);
        assert_eq!(fbank.compute(&vec![0.0; 16_000]).len(), 98 * 80);
    }

    #[test]
    fn a_tone_lands_in_the_right_mel_bin() {
        let fbank = Fbank::new(16_000, 80);
        let tone: Vec<f32> = (0..16_000)
            .map(|i| (2.0 * std::f32::consts::PI * 1_000.0 * i as f32 / 16_000.0).sin() * 0.5)
            .collect();
        let features = fbank.compute(&tone);
        let first = &features[..80];
        let loudest = first
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map(|(bin, _)| bin)
            .unwrap();
        // 1 kHz sits about a third of the way up the mel scale to 8 kHz.
        let expected =
            ((mel(1_000.0) - mel(LOW_HZ)) / (mel(8_000.0) - mel(LOW_HZ)) * 81.0) as usize;
        assert!(
            loudest.abs_diff(expected) <= 1,
            "loudest {loudest}, expected about {expected}"
        );
    }
}
