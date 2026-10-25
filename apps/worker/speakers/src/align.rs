//! Word timings for a transcript that arrived without them (forced
//! alignment). A multilingual CTC speech model (Omnilingual ASR CTC, as
//! exported to ONNX) scores every 20 ms of the audio against its characters;
//! the transcript's own words are then placed on the audio along the most
//! likely path, so each word gets a start and an end.
//!
//! Long audio is never aligned in one piece: the model's own quick reading of
//! the audio (greedy decoding) is matched word for word against the
//! transcript, and runs of agreeing words become fixed points that cut the
//! recording into short blocks. Each block is then aligned exactly. Memory and
//! time stay proportional to the audio.

use crate::models::{Result, session};
use ort::environment::Environment;
use ort::session::Session;
use ort::value::Tensor;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

/// Samples per output frame: 20 ms at 16 kHz.
pub const FRAME: usize = 320;
const SAMPLE_RATE: usize = 16_000;
/// Audio the model sees at once. Upstream keeps inputs under 40 s.
const CORE_SECONDS: usize = 26;
/// Audio on either side of a window's core, so no frame is scored at an edge.
const CONTEXT_SECONDS: usize = 2;
/// Largest block aligned exactly, in frames times states (one byte each).
const MAX_CELLS: usize = 64 << 20;
const NEG: f32 = -1.0e30;
const END_PADDING_FRAMES: usize = 2;
/// The gap token's id in a block's token list; no vocabulary is this large.
const GAP: u32 = u32::MAX;
/// What a frame of speech costs when the transcript has no words for it,
/// against its best character: high enough that the transcript's own words
/// are placed on their sound, low enough that left-out speech goes to a gap.
const GAP_PENALTY: f32 = 1.0;
/// Letters a run of agreeing words needs before it may anchor the audio.
const MIN_ANCHOR_LETTERS: usize = 12;

/// A placed word: its first frame, the frame after its last, and its mean
/// score when it was aligned on its own.
type Span = (usize, usize, Option<f32>);

fn err(context: &str) -> impl Fn(ort::Error) -> String + '_ {
    move |error| format!("{context}: {error}")
}

pub struct Aligner {
    session: Session,
    vocab: HashMap<char, u32>,
    blank: u32,
    space: Option<u32>,
}

/// Frame scores kept only for the characters the transcript uses.
struct Emissions {
    /// Log-probabilities, `frames * columns`.
    scores: Vec<f32>,
    columns: usize,
    /// Token to its column.
    column: HashMap<u32, usize>,
    /// The model's own best token for each frame.
    best: Vec<u32>,
    /// Score of a gap per frame: a space, or speech the transcript left out.
    gaps: Vec<f32>,
    frames: usize,
    /// Samples the audio had.
    samples: usize,
}

impl Emissions {
    /// Append a frame the model did not score: silence.
    fn push_silence(&mut self) {
        self.scores.push(0.0);
        self.scores
            .extend(std::iter::repeat_n(NEG, self.columns - 1));
        self.best.push(u32::MAX);
        self.gaps.push(NEG);
        self.frames += 1;
    }

    fn score(&self, frame: usize, token: u32) -> f32 {
        self.scores[frame * self.columns + self.column[&token]]
    }
    fn gap(&self, frame: usize) -> f32 {
        self.gaps[frame]
    }
}

#[derive(Serialize, Clone, Default)]
pub struct WordTiming {
    #[serde(rename = "startMs")]
    pub start_ms: u64,
    #[serde(rename = "endMs")]
    pub end_ms: u64,
    /// Mean log-probability of the word's characters along the path; absent
    /// when the word could not be placed on its own.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f32>,
}

#[derive(Serialize, Default)]
pub struct Alignment {
    pub words: Vec<WordTiming>,
    /// Words fixed by agreement with the model's own reading.
    #[serde(rename = "anchoredWords")]
    pub anchored_words: usize,
    /// Words spread evenly because their block could not be aligned.
    #[serde(rename = "spreadWords")]
    pub spread_words: usize,
    /// Words with no characters the model knows (numbers in some scripts,
    /// symbols); they take their neighbour's time.
    #[serde(rename = "untimedWords")]
    pub untimed_words: usize,
    pub blocks: usize,
    #[serde(rename = "largestBlockCells")]
    pub largest_block_cells: usize,
    #[serde(rename = "audioMs")]
    pub audio_ms: u64,
}

/// 32-bit float PCM read as the windows need it, so a long recording is never
/// held whole.
struct Samples<R: Read> {
    input: R,
    bytes: Vec<u8>,
    held: usize,
    ended: bool,
}

impl<R: Read> Samples<R> {
    fn new(input: R) -> Self {
        Self {
            input,
            bytes: vec![0; 1 << 16],
            held: 0,
            ended: false,
        }
    }

    /// Read until `out` holds `count` samples or the audio ends.
    fn fill(&mut self, out: &mut Vec<f32>, count: usize) -> Result<()> {
        while out.len() < count && !self.ended {
            let read = match self.input.read(&mut self.bytes[self.held..]) {
                Ok(0) => {
                    self.ended = true;
                    if self.held != 0 {
                        return Err("the audio is not 32-bit float PCM".into());
                    }
                    break;
                }
                Ok(read) => read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(format!("reading audio: {error}")),
            };
            let filled = self.held + read;
            let whole = filled - filled % 4;
            out.extend(
                self.bytes[..whole]
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
            );
            self.bytes.copy_within(whole..filled, 0);
            self.held = filled - whole;
        }
        Ok(())
    }
}

impl Aligner {
    pub fn load(env: &Environment, model: &Path, tokens: &Path, threads: usize) -> Result<Self> {
        let session = session(env, model, threads)?;
        let text = std::fs::read_to_string(tokens)
            .map_err(|error| format!("reading {}: {error}", tokens.display()))?;
        let mut vocab = HashMap::new();
        let mut blank = None;
        for line in text.lines() {
            let Some((token, id)) = line.rsplit_once(' ') else {
                continue;
            };
            let id: u32 = id
                .trim()
                .parse()
                .map_err(|_| format!("{}: bad line {line:?}", tokens.display()))?;
            match token {
                "<s>" | "<blk>" | "<blank>" => blank = blank.or(Some(id)),
                _ => {
                    let mut chars = token.chars();
                    if let (Some(c), None) = (chars.next(), chars.next()) {
                        vocab.insert(c, id);
                    }
                }
            }
        }
        let blank = blank.ok_or("the alignment vocabulary has no blank token")?;
        let space = vocab.get(&' ').copied();
        Ok(Self {
            session,
            vocab,
            blank,
            space,
        })
    }

    /// The tokens of one word as the model writes it: NFC, lower case,
    /// letters, digits and apostrophes it knows.
    fn tokens(&self, word: &str) -> (String, Vec<u32>) {
        let mut key = String::new();
        let mut ids = Vec::new();
        for c in word.nfc().flat_map(char::to_lowercase) {
            let c = if c == '\u{2019}' { '\'' } else { c };
            if !(c.is_alphanumeric() || c == '\'') {
                continue;
            }
            if let Some(&id) = self.vocab.get(&c) {
                key.push(c);
                ids.push(id);
            }
        }
        (key, ids)
    }

    fn emissions(&mut self, audio: impl Read, wanted: &[u32]) -> Result<Emissions> {
        let mut column = HashMap::new();
        for &token in std::iter::once(&self.blank).chain(wanted) {
            let next = column.len();
            column.entry(token).or_insert(next);
        }
        let mut emissions = Emissions {
            scores: Vec::new(),
            columns: column.len(),
            column,
            best: Vec::new(),
            gaps: Vec::new(),
            frames: 0,
            samples: 0,
        };
        let space_column = self.space.map(|space| emissions.column[&space]);
        let (core, context) = (CORE_SECONDS * SAMPLE_RATE, CONTEXT_SECONDS * SAMPLE_RATE);
        let mut samples = Samples::new(audio);
        // The audio from sample `base` on, as far as has been read.
        let (mut buffer, mut base) = (Vec::new(), 0usize);
        let mut core_start = 0;
        loop {
            samples.fill(&mut buffer, core_start + core + context - base)?;
            let available = base + buffer.len();
            if core_start >= available {
                break;
            }
            let core_end = (core_start + core).min(available);
            let from = core_start.saturating_sub(context);
            let to = (core_end + context).min(available);
            let mut input = buffer[from - base..to - base].to_vec();
            // The convolutional front end needs a little audio to work on.
            if input.len() < SAMPLE_RATE / 4 {
                input.resize(SAMPLE_RATE / 4, 0.0);
            }
            let length = input.len();
            let tensor = Tensor::from_array(([1, length], input)).map_err(err("input"))?;
            let outputs = self
                .session
                .run(ort::inputs![tensor])
                .map_err(err("alignment model"))?;
            let (shape, logits) = outputs[0]
                .try_extract_tensor::<f32>()
                .map_err(err("alignment output"))?;
            let (count, vocab) = (shape[1] as usize, shape[2] as usize);
            let first = from / FRAME;
            let (keep_from, keep_to) = (core_start / FRAME, core_end.div_ceil(FRAME));
            // Frames the model never reaches (the last few samples) stay
            // silence.
            while emissions.frames < keep_to {
                emissions.push_silence();
            }
            for (index, row) in logits.chunks_exact(vocab).take(count).enumerate() {
                let frame = first + index;
                if frame < keep_from || frame >= keep_to {
                    continue;
                }
                let (mut top, mut top_id) = (f32::NEG_INFINITY, 0usize);
                let mut speech = f32::NEG_INFINITY;
                for (id, &value) in row.iter().enumerate() {
                    if value > top {
                        (top, top_id) = (value, id);
                    }
                    if id != self.blank as usize && value > speech {
                        speech = value;
                    }
                }
                let total = top
                    + row
                        .iter()
                        .map(|value| (value - top).exp())
                        .sum::<f32>()
                        .ln();
                emissions.best[frame] = top_id as u32;
                let offset = frame * emissions.columns;
                for (&token, &col) in &emissions.column {
                    emissions.scores[offset + col] = row[token as usize] - total;
                }
                let space = space_column.map_or(NEG, |col| emissions.scores[offset + col]);
                emissions.gaps[frame] = space.max(speech - total - GAP_PENALTY);
            }
            core_start = core_end;
            // Keep only what the next window's context reaches back to.
            let keep = core_start.saturating_sub(context);
            buffer.drain(..keep - base);
            base = keep;
        }
        emissions.samples = base + buffer.len();
        if emissions.frames == 0 {
            emissions.push_silence();
        }
        // Unscored frames read as the blank.
        for token in &mut emissions.best {
            if *token == u32::MAX {
                *token = self.blank;
            }
        }
        Ok(emissions)
    }

    /// Words the model itself heard, with the frames they span.
    fn heard(&self, emissions: &Emissions) -> Vec<(String, usize, usize)> {
        let reverse: HashMap<u32, char> = self.vocab.iter().map(|(&c, &id)| (id, c)).collect();
        let mut words = Vec::new();
        let mut current = String::new();
        let (mut start, mut end) = (0, 0);
        let mut previous = self.blank;
        let mut finish = |current: &mut String, start: usize, end: usize| {
            if !current.is_empty() {
                let (key, _) = self.tokens(current);
                if !key.is_empty() {
                    words.push((key, start, end));
                }
                current.clear();
            }
        };
        for (frame, &token) in emissions.best.iter().enumerate() {
            if token == self.blank {
                previous = token;
                continue;
            }
            let c = reverse.get(&token).copied().unwrap_or(' ');
            let separator = Some(token) == self.space || !(c.is_alphanumeric() || c == '\'');
            if separator {
                finish(&mut current, start, end);
            } else if token == previous {
                end = frame + 1;
            } else {
                if current.is_empty() {
                    start = frame;
                }
                current.push(c);
                end = frame + 1;
            }
            previous = token;
        }
        finish(&mut current, start, end);
        words
    }

    pub fn align(&mut self, audio: impl Read, words: &[String]) -> Result<Alignment> {
        let tokenized: Vec<(String, Vec<u32>)> = words.iter().map(|w| self.tokens(w)).collect();
        let mut wanted: Vec<u32> = tokenized.iter().flat_map(|(_, ids)| ids.clone()).collect();
        wanted.extend(self.space);
        wanted.sort_unstable();
        wanted.dedup();
        let emissions = self.emissions(audio, &wanted)?;
        let heard = self.heard(&emissions);
        let anchors = anchors(&tokenized, &heard);

        let mut result = Alignment {
            words: vec![WordTiming::default(); words.len()],
            anchored_words: anchors.len(),
            audio_ms: (emissions.samples * 1000 / SAMPLE_RATE) as u64,
            ..Default::default()
        };
        // Cut before each anchor: block k runs from cut k to cut k + 1.
        let mut cuts: Vec<(usize, usize)> = vec![(0, 0)];
        for &(word, frame) in &anchors {
            if word > cuts.last().unwrap().0 && frame > cuts.last().unwrap().1 {
                cuts.push((word, frame));
            }
        }
        cuts.push((words.len(), emissions.frames));
        let mut placed: Vec<Option<Span>> = vec![None; words.len()];
        for pair in cuts.windows(2) {
            let ((word_from, frame_from), (word_to, frame_to)) = (pair[0], pair[1]);
            if word_from >= word_to {
                continue;
            }
            result.blocks += 1;
            let block = &tokenized[word_from..word_to];
            let frames = frame_to.max(frame_from + 1) - frame_from;
            let states = 2 * block.iter().map(|(_, ids)| ids.len() + 1).sum::<usize>() + 3;
            result.largest_block_cells = result.largest_block_cells.max(frames * states);
            let exact = if frames * states <= MAX_CELLS {
                self.viterbi(&emissions, block, frame_from, frames)
            } else {
                None
            };
            match exact {
                Some(spans) => {
                    for (offset, span) in spans.into_iter().enumerate() {
                        placed[word_from + offset] = span;
                    }
                }
                None => {
                    let total: usize = block.iter().map(|(_, ids)| ids.len()).sum();
                    let mut done = 0;
                    for (offset, (_, ids)) in block.iter().enumerate() {
                        if ids.is_empty() {
                            continue;
                        }
                        let start = frame_from + frames * done / total.max(1);
                        done += ids.len();
                        let end = frame_from + frames * done / total.max(1);
                        placed[word_from + offset] = Some((start, end.max(start + 1), None));
                        result.spread_words += 1;
                    }
                }
            }
        }
        // CTC marks a character on the frame it is most sure of, which ends a
        // word a little before its sound does; let it run on up to two frames
        // (40 ms), never into the next word.
        for index in 0..placed.len() {
            let next_start = placed[index + 1..]
                .iter()
                .flatten()
                .map(|span| span.0)
                .next()
                .unwrap_or(emissions.frames);
            if let Some(span) = placed[index].as_mut() {
                span.1 = (span.1 + END_PADDING_FRAMES).min(next_start.max(span.1));
            }
        }
        let ms = |frame: usize| (frame * FRAME * 1000 / SAMPLE_RATE) as u64;
        let mut previous_end = 0;
        for (index, span) in placed.iter().enumerate() {
            result.words[index] = match span {
                Some((start, end, score)) => {
                    previous_end = ms(*end);
                    WordTiming {
                        start_ms: ms(*start),
                        end_ms: ms(*end),
                        score: *score,
                    }
                }
                None => {
                    result.untimed_words += 1;
                    WordTiming {
                        start_ms: previous_end,
                        end_ms: previous_end,
                        score: None,
                    }
                }
            };
        }
        Ok(result)
    }

    /// The most likely placement of `block`'s words on `frames` frames from
    /// `frame_from`: each word's first and last frame and its mean score, or
    /// None when the words can't fit.
    fn viterbi(
        &self,
        emissions: &Emissions,
        block: &[(String, Vec<u32>)],
        frame_from: usize,
        frames: usize,
    ) -> Option<Vec<Option<Span>>> {
        // The usual CTC trellis (a blank around every token), with an
        // optional gap token before, between and after the words. A gap is a
        // space or speech the transcript left out (crosstalk, a murmur), so
        // such speech is not smeared over the neighbouring words.
        let mut tokens: Vec<u32> = Vec::new();
        let mut word_of: Vec<Option<usize>> = Vec::new();
        for (index, (_, ids)) in block.iter().enumerate() {
            if ids.is_empty() {
                continue;
            }
            tokens.push(GAP);
            word_of.push(None);
            for &id in ids {
                tokens.push(id);
                word_of.push(Some(index));
            }
        }
        if tokens.is_empty() {
            return Some(vec![None; block.len()]);
        }
        tokens.push(GAP);
        word_of.push(None);
        // State 2k is a blank, 2k + 1 is token k.
        let states = 2 * tokens.len() + 1;
        let token_of = |s: usize| {
            if s.is_multiple_of(2) {
                self.blank
            } else {
                tokens[s / 2]
            }
        };
        let optional = |s: usize| s % 2 == 1 && tokens[s / 2] == GAP;
        let predecessors = |s: usize| -> [Option<usize>; 5] {
            let mut list = [Some(s), s.checked_sub(1), None, None, None];
            if s % 2 == 1 && s >= 2 && token_of(s - 2) != token_of(s) {
                list[2] = Some(s - 2);
            }
            // Past an optional token: from the blank before it, and from the
            // token before it when the two differ.
            if s >= 3 && optional(s - 2) && s % 2 == 1 {
                list[3] = Some(s - 3);
                if s >= 4 && token_of(s - 4) != token_of(s) {
                    list[4] = Some(s - 4);
                }
            } else if s >= 2 && s.is_multiple_of(2) && optional(s - 1) {
                list[3] = Some(s - 2);
            }
            list
        };
        let score = |frame: usize, s: usize| -> f32 {
            match token_of(s) {
                GAP => emissions.gap(frame),
                token => emissions.score(frame, token),
            }
        };
        let mut back = vec![0u8; frames * states];
        let mut previous = vec![NEG; states];
        let mut current = vec![NEG; states];
        // The path starts on the first blank or gap, or skips the gap.
        for s in [0, 1, 2, 3] {
            previous[s] = score(frame_from, s);
        }
        for t in 1..frames {
            let frame = frame_from + t;
            for s in 0..states {
                let (mut best, mut which) = (NEG, 0u8);
                for (slot, p) in predecessors(s).iter().enumerate() {
                    if let Some(p) = *p
                        && previous[p] > best
                    {
                        (best, which) = (previous[p], slot as u8);
                    }
                }
                current[s] = if best <= NEG / 2.0 {
                    NEG
                } else {
                    best + score(frame, s)
                };
                back[t * states + s] = which;
            }
            std::mem::swap(&mut previous, &mut current);
        }
        // It ends on the last blank or gap, or before the gap.
        let mut s = (states - 4..states)
            .max_by(|a, b| previous[*a].total_cmp(&previous[*b]))
            .unwrap();
        if previous[s] <= NEG / 2.0 {
            return None;
        }
        let mut spans: Vec<Option<Span>> = vec![None; block.len()];
        let mut sums = vec![(0f32, 0usize); block.len()];
        for t in (0..frames).rev() {
            if s % 2 == 1
                && let Some(word) = word_of[s / 2]
            {
                let frame = frame_from + t;
                let span = spans[word].get_or_insert((frame, frame + 1, None));
                span.0 = frame;
                sums[word].0 += score(frame, s);
                sums[word].1 += 1;
            }
            if t > 0 {
                s = predecessors(s)[back[t * states + s] as usize].unwrap_or(s);
            }
        }
        for (span, (sum, count)) in spans.iter_mut().zip(sums) {
            if let Some(span) = span {
                span.2 = Some(sum / count.max(1) as f32);
            }
        }
        Some(spans)
    }
}

/// Transcript words that agree with the model's own reading, inside a run of
/// at least three agreeing words, with the frame the heard word starts on.
fn anchors(
    transcript: &[(String, Vec<u32>)],
    heard: &[(String, usize, usize)],
) -> Vec<(usize, usize)> {
    let keyed: Vec<usize> = (0..transcript.len())
        .filter(|&index| !transcript[index].0.is_empty())
        .collect();
    let (n, m) = (keyed.len(), heard.len());
    if n == 0 || m == 0 {
        return Vec::new();
    }
    // Longest common subsequence of words, inside a band around the
    // diagonal: both are readings of the same speech, so they drift apart
    // only by the words one of them dropped.
    let width = (n.max(m) / 8).max(64).max(n.abs_diff(m) + 16).min(4096);
    let span = 2 * width + 1;
    let centre = |i: usize| i * m / n;
    let mut back = vec![0u8; n * span];
    let mut previous = vec![0i32; m + 1];
    let mut current = vec![0i32; m + 1];
    for i in 0..n {
        let c = centre(i);
        let (lo, hi) = (c.saturating_sub(width), (c + width).min(m - 1));
        current.copy_from_slice(&previous);
        for j in lo..=hi {
            let up = previous[j + 1];
            let left = current[j];
            let diagonal = if transcript[keyed[i]].0 == heard[j].0 {
                previous[j] + 1
            } else {
                i32::MIN
            };
            let (value, step) = if diagonal >= up && diagonal >= left {
                (diagonal, 3)
            } else if up >= left {
                (up, 1)
            } else {
                (left, 2)
            };
            current[j + 1] = value;
            back[i * span + (j + width - c)] = step;
        }
        // Cells to the right of the band carry the best value forward.
        for j in hi + 1..m {
            current[j + 1] = current[j + 1].max(current[j]);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    let mut pairs = Vec::new();
    let (mut i, mut j) = (n as isize - 1, m as isize - 1);
    while i >= 0 && j >= 0 {
        let c = centre(i as usize);
        let offset = j + width as isize - c as isize;
        let step = if offset < 0 || offset >= span as isize {
            if (j as usize) > c { 2 } else { 1 }
        } else {
            back[i as usize * span + offset as usize]
        };
        match step {
            3 => {
                pairs.push((i as usize, j as usize));
                i -= 1;
                j -= 1;
            }
            1 => i -= 1,
            2 => j -= 1,
            _ => {
                if (j as usize) > c {
                    j -= 1
                } else {
                    i -= 1
                }
            }
        }
    }
    pairs.reverse();
    // Runs of consecutive agreeing words. A run anchors its inner words only
    // when it is long enough to be unmistakable: three short repeats such as
    // "yes yes yes" agree just as well with the wrong occurrence.
    let mut result = Vec::new();
    let mut start = 0;
    while start < pairs.len() {
        let mut end = start + 1;
        while end < pairs.len()
            && pairs[end].0 == pairs[end - 1].0 + 1
            && pairs[end].1 == pairs[end - 1].1 + 1
        {
            end += 1;
        }
        let run = &pairs[start..end];
        let letters: usize = run
            .iter()
            .map(|&(i, _)| transcript[keyed[i]].0.chars().count())
            .sum();
        let distinct = run
            .iter()
            .map(|&(i, _)| transcript[keyed[i]].0.as_str())
            .collect::<std::collections::HashSet<_>>()
            .len();
        if run.len() >= 3 && letters >= MIN_ANCHOR_LETTERS && distinct >= 2 {
            for &(i, j) in &run[1..run.len() - 1] {
                result.push((keyed[i], heard[j].1));
            }
        }
        start = end;
    }
    result
}
