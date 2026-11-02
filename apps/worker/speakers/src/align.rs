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
//!
//! The model only hears the audio that has sound in it. A meeting's tracks
//! are quiet for much of the time (a microphone while its person listens, the
//! call's audio while they talk), and a long quiet stretch can't hold a word.
//! Such stretches are taken out, keeping a short margin on either side, and
//! the rest is joined up and scored in the usual windows, so the model still
//! hears each sound among its neighbours. The frames taken out read as
//! silence.

use crate::models::{Result, session};
use ort::environment::Environment;
use ort::session::Session;
use ort::value::Tensor;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
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
/// What each frame of a pause inside a word costs: a few frames between two
/// characters cost next to nothing, a word stretched over a long silence
/// costs far more than placing it on one sound.
const INSIDE_WORD_BLANK: f32 = 0.05;
/// A frame quieter than this (-55 dBFS) has no speech in it: well below a
/// voice, even a soft one across the room, and above the near-silence of an
/// idle microphone or of a call while nobody on it talks.
const QUIET_RMS: f32 = 0.001_78;
/// Quiet kept on either side of a sound: a word's soft start and end.
const QUIET_MARGIN_FRAMES: usize = 25;
/// A quiet stretch at least this long (1.5 s) is taken out, but for its margins.
const QUIET_CUT_FRAMES: usize = 75;

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

fn loud(frame: &[f32]) -> bool {
    let energy = frame.iter().map(|sample| sample * sample).sum::<f32>() / frame.len() as f32;
    energy > QUIET_RMS * QUIET_RMS
}

/// The audio without its long quiet stretches, read like [`Samples`], and the
/// recording frame each of its frames came from.
struct Sounding<R: Read> {
    samples: Samples<R>,
    /// Recording samples read but not yet looked at.
    raw: Vec<f32>,
    /// Where in `raw` the next frame starts.
    next: usize,
    /// The current quiet stretch's frames not yet passed on or dropped.
    held: VecDeque<(usize, Vec<f32>)>,
    /// Frames in the current quiet stretch.
    quiet: usize,
    /// Recording frames read.
    read: usize,
    /// Recording samples read.
    total: usize,
    /// For each frame passed on, its frame in the recording.
    origin: Vec<usize>,
    ended: bool,
}

impl<R: Read> Sounding<R> {
    fn new(input: R) -> Self {
        Self {
            samples: Samples::new(input),
            raw: Vec::new(),
            next: 0,
            held: VecDeque::new(),
            quiet: 0,
            read: 0,
            total: 0,
            origin: Vec::new(),
            ended: false,
        }
    }

    fn pass(&mut self, out: &mut Vec<f32>, at: usize, frame: &[f32]) {
        out.extend_from_slice(frame);
        self.origin.push(at);
    }

    /// Read until `out` holds `count` samples or the audio ends.
    fn fill(&mut self, out: &mut Vec<f32>, count: usize) -> Result<()> {
        while out.len() < count && !self.ended {
            if self.raw.len() - self.next < FRAME {
                self.raw.drain(..self.next);
                self.next = 0;
                self.samples.fill(&mut self.raw, FRAME)?;
            }
            if self.raw.len() == self.next {
                // A short pause at the end stays; a long one was cut.
                if self.quiet < QUIET_CUT_FRAMES {
                    while let Some((at, frame)) = self.held.pop_front() {
                        self.pass(out, at, &frame);
                    }
                }
                self.ended = true;
                break;
            }
            let at = self.read;
            self.read += 1;
            let end = (self.next + FRAME).min(self.raw.len());
            let frame = self.raw[self.next..end].to_vec();
            self.next = end;
            self.total += frame.len();
            if loud(&frame) {
                // The pause before it: whole when short, else its last margin.
                while let Some((at, held)) = self.held.pop_front() {
                    self.pass(out, at, &held);
                }
                self.quiet = 0;
                self.pass(out, at, &frame);
            } else {
                self.quiet += 1;
                self.held.push_back((at, frame));
                if self.quiet == QUIET_CUT_FRAMES && !self.origin.is_empty() {
                    // A long pause: the margin after the sound before it
                    // stays.
                    for _ in 0..QUIET_MARGIN_FRAMES {
                        let (at, held) = self.held.pop_front().expect("held");
                        self.pass(out, at, &held);
                    }
                }
                if self.quiet >= QUIET_CUT_FRAMES {
                    while self.held.len() > QUIET_MARGIN_FRAMES {
                        self.held.pop_front();
                    }
                }
            }
        }
        Ok(())
    }
}

/// Emissions over the joined-up sound, put back on the recording's frames.
fn expand(sound: Emissions, origin: &[usize], samples: usize) -> Emissions {
    let mut emissions = Emissions {
        scores: Vec::new(),
        columns: sound.columns,
        column: sound.column,
        best: Vec::new(),
        gaps: Vec::new(),
        frames: 0,
        samples,
    };
    let columns = sound.columns;
    for (index, &at) in origin.iter().enumerate().take(sound.frames) {
        while emissions.frames < at {
            emissions.push_silence();
        }
        emissions
            .scores
            .extend_from_slice(&sound.scores[index * columns..(index + 1) * columns]);
        emissions.best.push(sound.best[index]);
        emissions.gaps.push(sound.gaps[index]);
        emissions.frames += 1;
    }
    while emissions.frames < samples.div_ceil(FRAME) {
        emissions.push_silence();
    }
    emissions
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
        let mut samples = Sounding::new(audio);
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
        let mut emissions = expand(emissions, &samples.origin, samples.total);
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
        // Cut before each anchor: block k runs from cut k to cut k + 1.
        let mut cuts: Vec<(usize, usize)> = vec![(0, 0)];
        cuts.extend(block_cuts(
            &tokenized,
            &heard,
            (0, 0),
            (words.len(), emissions.frames),
            0,
        ));
        cuts.push((words.len(), emissions.frames));
        let mut result = Alignment {
            words: vec![WordTiming::default(); words.len()],
            anchored_words: cuts.len() - 2,
            audio_ms: (emissions.samples * 1000 / SAMPLE_RATE) as u64,
            ..Default::default()
        };
        let mut placed: Vec<Option<Span>> = vec![None; words.len()];
        for pair in cuts.windows(2) {
            let ((word_from, frame_from), (word_to, frame_to)) = (pair[0], pair[1]);
            if word_from >= word_to {
                continue;
            }
            result.blocks += 1;
            let block = &tokenized[word_from..word_to];
            let frames = frame_to.max(frame_from + 1) - frame_from;
            let states = block_states(block);
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
        viterbi(self.blank, emissions, block, frame_from, frames)
    }
}

/// The most likely placement of `block`'s words on `frames` frames from
/// `frame_from`; see [`Aligner::viterbi`].
fn viterbi(
    blank: u32,
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
    // Blanks between two of a word's own characters. Each frame there costs
    // a little (INSIDE_WORD_BLANK), so a word stays in one piece instead of
    // starting on a sound long before the rest of it; silence between words
    // stays free.
    let inside: Vec<bool> = (0..states)
        .map(|s| {
            let k = s / 2;
            s % 2 == 0
                && k >= 1
                && k < tokens.len()
                && word_of[k].is_some()
                && word_of[k - 1] == word_of[k]
        })
        .collect();
    let token_of = |s: usize| {
        if s.is_multiple_of(2) {
            blank
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
            token if inside[s] => emissions.score(frame, token) - INSIDE_WORD_BLANK,
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

/// How sure a run of agreeing words must be to anchor the audio: its words
/// and letters. The first level cuts every recording; a block still too large
/// to align exactly is cut again with the next, looser one.
const ANCHOR_LEVELS: [(usize, usize); 3] = [(3, MIN_ANCHOR_LETTERS), (2, 8), (1, 5)];

/// States a block of words needs in the alignment trellis.
fn block_states(block: &[(String, Vec<u32>)]) -> usize {
    2 * block.iter().map(|(_, ids)| ids.len() + 1).sum::<usize>() + 3
}

/// The cuts strictly between `from` and `to` (each a word and the frame it
/// starts on): anchors at `level`, then, inside any block still too large to
/// align exactly, anchors at the looser levels.
fn block_cuts(
    transcript: &[(String, Vec<u32>)],
    heard: &[(String, usize, usize)],
    from: (usize, usize),
    to: (usize, usize),
    level: usize,
) -> Vec<(usize, usize)> {
    let cells = (to.1 - from.1) * block_states(&transcript[from.0..to.0]);
    if level >= ANCHOR_LEVELS.len() || (level > 0 && cells <= MAX_CELLS) {
        return Vec::new();
    }
    let first = heard.partition_point(|word| word.1 < from.1);
    let last = heard.partition_point(|word| word.1 < to.1);
    let mut cuts = Vec::new();
    let mut previous = from;
    for (word, frame) in anchors(
        &transcript[from.0..to.0],
        &heard[first..last],
        ANCHOR_LEVELS[level],
    ) {
        let cut = (from.0 + word, frame);
        if cut.0 > previous.0 && cut.1 > previous.1 && cut.0 < to.0 && cut.1 < to.1 {
            cuts.push(cut);
            previous = cut;
        }
    }
    let mut result = Vec::new();
    let mut start = from;
    for end in cuts.iter().copied().chain(std::iter::once(to)) {
        result.extend(block_cuts(transcript, heard, start, end, level + 1));
        if end != to {
            result.push(end);
        }
        start = end;
    }
    result
}

/// Transcript words that agree with the model's own reading, inside a run of
/// agreeing words sure enough for `(words, letters)`, with the frame the
/// heard word starts on.
fn anchors(
    transcript: &[(String, Vec<u32>)],
    heard: &[(String, usize, usize)],
    (min_run, min_letters): (usize, usize),
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
        // A long run anchors its inner words, whose neighbours agree too; a
        // short one, allowed only at the looser levels, anchors them all.
        let longest = run
            .iter()
            .map(|&(i, _)| transcript[keyed[i]].0.chars().count())
            .max()
            .unwrap_or(0);
        // Short words alone ("yes yes no") agree as well with the wrong
        // occurrence; a run needs one word long enough to be unmistakable.
        if run.len() >= min_run && letters >= min_letters && longest >= 4 {
            if run.len() >= 3 && distinct >= 2 {
                for &(i, j) in &run[1..run.len() - 1] {
                    result.push((keyed[i], heard[j].1));
                }
            } else if run.len() < 3 {
                for &(i, j) in run {
                    result.push((keyed[i], heard[j].1));
                }
            }
        }
        start = end;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Emissions over tokens 0 (blank), 1 and 2 where each frame is sure of
    /// the token `script` gives it (`.` for the blank).
    fn emissions(script: &str) -> Emissions {
        let column: HashMap<u32, usize> = [(0, 0), (1, 1), (2, 2)].into_iter().collect();
        let mut scores = Vec::new();
        let mut best = Vec::new();
        for c in script.chars() {
            let token = match c {
                'a' => 1,
                'b' => 2,
                _ => 0,
            };
            for column in 0..3 {
                scores.push(if column == token { -0.01 } else { -8.0 });
            }
            best.push(token as u32);
        }
        let frames = script.len();
        Emissions {
            scores,
            columns: 3,
            column,
            best,
            gaps: vec![-9.0; frames],
            frames,
            samples: frames * FRAME,
        }
    }

    fn word(text: &str, ids: &[u32]) -> (String, Vec<u32>) {
        (text.to_string(), ids.to_vec())
    }

    #[test]
    fn places_each_word_on_its_sound() {
        let block = [word("a", &[1]), word("b", &[2])];
        let spans = viterbi(0, &emissions("..aa...bb.."), &block, 0, 11).unwrap();
        let frames: Vec<_> = spans.iter().map(|span| span.map(|s| (s.0, s.1))).collect();
        assert_eq!(frames, vec![Some((2, 4)), Some((7, 9))]);
        assert!(spans.iter().all(|span| span.unwrap().2.unwrap() > -1.0));
    }

    #[test]
    fn a_word_with_no_sound_of_its_own_is_left_untimed() {
        let block = [word("a", &[1]), word("…", &[]), word("b", &[2])];
        let spans = viterbi(0, &emissions(".a..b."), &block, 0, 6).unwrap();
        assert_eq!(spans[1], None);
        assert_eq!(spans[0].map(|s| s.0), Some(1));
        assert_eq!(spans[2].map(|s| s.0), Some(4));
    }

    #[test]
    fn a_word_stays_in_one_piece_across_a_silence() {
        // Its first character also sounds alone long before the word: the
        // two placements score the same but for the pause inside the word.
        let script = format!(".a{}ab.", ".".repeat(40));
        let spans = viterbi(
            0,
            &emissions(&script),
            &[word("ab", &[1, 2])],
            0,
            script.len(),
        )
        .unwrap();
        assert_eq!(spans[0].map(|s| (s.0, s.1)), Some((42, 44)));
    }

    fn heard(words: &[&str]) -> Vec<(String, usize, usize)> {
        words
            .iter()
            .enumerate()
            .map(|(index, text)| (text.to_string(), index * 10, index * 10 + 5))
            .collect()
    }

    fn transcript(words: &[&str]) -> Vec<(String, Vec<u32>)> {
        words
            .iter()
            .map(|text| (text.to_string(), vec![1; text.len()]))
            .collect()
    }

    #[test]
    fn a_long_agreeing_run_anchors_its_inner_words() {
        let words = ["so", "the", "remote", "control", "needs", "buttons"];
        let found = anchors(&transcript(&words), &heard(&words), ANCHOR_LEVELS[0]);
        assert_eq!(found, vec![(1, 10), (2, 20), (3, 30), (4, 40)]);
    }

    #[test]
    fn repeated_short_words_never_anchor_at_first() {
        let words = ["yes", "yes", "yes", "no", "no"];
        assert!(anchors(&transcript(&words), &heard(&words), ANCHOR_LEVELS[0]).is_empty());
    }

    /// Audio with one frame per character of `script`: `x` a sound, `.`
    /// near-silence. Each frame's samples carry its number, to follow it.
    fn audio(script: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        for (at, c) in script.chars().enumerate() {
            let level = if c == 'x' { 0.1 } else { 0.0001 };
            let sample = level + at as f32 * 1e-7;
            for _ in 0..FRAME {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
        }
        bytes
    }

    /// The recording frames the sound passes on, read `step` samples at a time.
    fn sounding(script: &str, step: usize) -> (Vec<usize>, usize, Vec<f32>) {
        let bytes = audio(script);
        let mut sound = Sounding::new(bytes.as_slice());
        let mut out = Vec::new();
        loop {
            let before = out.len();
            sound.fill(&mut out, before + step).unwrap();
            if out.len() == before && sound.ended {
                break;
            }
        }
        (sound.origin, sound.total, out)
    }

    fn script(parts: &[(char, usize)]) -> String {
        parts
            .iter()
            .map(|&(c, n)| c.to_string().repeat(n))
            .collect()
    }

    #[test]
    fn a_long_quiet_stretch_is_taken_out_but_for_its_margins() {
        let (origin, total, out) = sounding(&script(&[('x', 1), ('.', 200), ('x', 1)]), 4000);
        let mut expected = vec![0];
        expected.extend(1..=QUIET_MARGIN_FRAMES);
        expected.extend(201 - QUIET_MARGIN_FRAMES..=201);
        assert_eq!(origin, expected);
        assert_eq!(total, 202 * FRAME);
        // Every frame passed on is the recording's own frame.
        assert_eq!(out.len(), origin.len() * FRAME);
        for (index, &at) in origin.iter().enumerate() {
            let level = if at == 0 || at == 201 { 0.1 } else { 0.0001 };
            assert!((out[index * FRAME] - (level + at as f32 * 1e-7)).abs() < 1e-9);
        }
    }

    #[test]
    fn a_short_pause_stays_whole() {
        let (origin, _, _) = sounding(
            &script(&[('x', 3), ('.', QUIET_CUT_FRAMES - 1), ('x', 3)]),
            4000,
        );
        assert_eq!(origin, (0..QUIET_CUT_FRAMES + 5).collect::<Vec<_>>());
    }

    #[test]
    fn quiet_at_either_end_keeps_only_a_margin_beside_the_sound() {
        let (origin, total, _) = sounding(&script(&[('.', 100), ('x', 2), ('.', 100)]), 4000);
        assert_eq!(
            origin,
            (100 - QUIET_MARGIN_FRAMES..102 + QUIET_MARGIN_FRAMES).collect::<Vec<_>>()
        );
        assert_eq!(total, 202 * FRAME);
        let (origin, _, _) = sounding(&script(&[('x', 2), ('.', 30)]), 4000);
        assert_eq!(origin, (0..32).collect::<Vec<_>>());
    }

    #[test]
    fn how_the_audio_is_read_does_not_change_what_is_kept() {
        let text = script(&[
            ('x', 7),
            ('.', 90),
            ('x', 1),
            ('.', 40),
            ('x', 12),
            ('.', 300),
            ('x', 5),
        ]);
        let whole = sounding(&text, 1 << 20);
        for step in [1, 319, 320, 321, 5000] {
            assert_eq!(sounding(&text, step), whole);
        }
    }

    #[test]
    fn emissions_go_back_on_the_frames_they_came_from() {
        let sound = emissions("ab");
        let expanded = expand(sound, &[1, 4], 6 * FRAME - 10);
        assert_eq!(expanded.frames, 6);
        assert_eq!(expanded.samples, 6 * FRAME - 10);
        assert_eq!(
            expanded.best,
            vec![u32::MAX, 1, u32::MAX, u32::MAX, 2, u32::MAX]
        );
        assert_eq!(&expanded.scores[3..6], &[-8.0, -0.01, -8.0]);
        assert_eq!(&expanded.scores[12..15], &[-8.0, -8.0, -0.01]);
        // A frame taken out reads as silence: the blank, and no gap.
        assert_eq!(&expanded.scores[6..9], &[0.0, NEG, NEG]);
        assert_eq!(expanded.gaps[2], NEG);
    }
}
