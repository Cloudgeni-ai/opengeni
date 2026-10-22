//! A small seeded generator, so random choices are reproducible.

/// `SplitMix64`: fast, well mixed and small enough to keep one per caller.
/// Not for secrets.
#[derive(Clone, Debug)]
pub struct Rng {
    state: u64,
}

impl Rng {
    /// A generator that yields the same sequence for the same seed.
    #[must_use]
    pub const fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    /// The next 64 random bits.
    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// A number below `bound`, which must not be zero; without the bias a
    /// plain remainder has.
    pub fn below(&mut self, bound: u64) -> u64 {
        debug_assert!(bound > 0, "below(0)");
        // Lemire's multiply-shift with rejection.
        loop {
            let product = u128::from(self.next_u64()) * u128::from(bound);
            #[allow(clippy::cast_possible_truncation)]
            let low = product as u64;
            if low >= bound.wrapping_neg() % bound {
                #[allow(clippy::cast_possible_truncation)]
                return (product >> 64) as u64;
            }
        }
    }

    /// An index into a collection of `len` items, which must not be empty.
    pub fn index(&mut self, len: usize) -> usize {
        #[allow(clippy::cast_possible_truncation)]
        let index = self.below(len as u64) as usize;
        index
    }

    /// True with probability `numerator / denominator`.
    pub fn chance(&mut self, numerator: u64, denominator: u64) -> bool {
        self.below(denominator) < numerator
    }
}

#[cfg(test)]
mod tests {
    use super::Rng;

    #[test]
    fn the_same_seed_gives_the_same_sequence() {
        let (mut a, mut b) = (Rng::new(7), Rng::new(7));
        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
        assert_ne!(Rng::new(7).next_u64(), Rng::new(8).next_u64());
    }

    #[test]
    fn below_stays_below_and_covers_the_range() {
        let mut rng = Rng::new(1);
        let mut seen = [0u32; 7];
        for _ in 0..7_000 {
            let value = rng.below(7);
            seen[usize::try_from(value).unwrap()] += 1;
        }
        assert!(
            seen.iter().all(|&count| (800..1200).contains(&count)),
            "{seen:?}"
        );
        assert_eq!(rng.below(1), 0);
    }
}
