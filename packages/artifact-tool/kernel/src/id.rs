use core::fmt;
use core::str::FromStr;

/// A process-independent entity identity.
///
/// The high 64 bits identify an allocation namespace and the low 64 bits are a
/// monotonic counter. The all-zero value is reserved and never generated.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[repr(transparent)]
pub struct StableId(u128);

impl StableId {
    pub const ZERO: Self = Self(0);

    #[must_use]
    pub const fn from_parts(namespace: u64, counter: u64) -> Self {
        Self(((namespace as u128) << 64) | counter as u128)
    }

    #[must_use]
    pub const fn from_u128(value: u128) -> Self {
        Self(value)
    }

    #[must_use]
    pub const fn as_u128(self) -> u128 {
        self.0
    }

    #[must_use]
    pub const fn namespace(self) -> u64 {
        (self.0 >> 64) as u64
    }

    #[must_use]
    pub const fn counter(self) -> u64 {
        self.0 as u64
    }

    #[must_use]
    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }

    #[must_use]
    pub const fn to_le_bytes(self) -> [u8; 16] {
        self.0.to_le_bytes()
    }

    #[must_use]
    pub const fn from_le_bytes(bytes: [u8; 16]) -> Self {
        Self(u128::from_le_bytes(bytes))
    }
}

impl fmt::Display for StableId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:032x}", self.0)
    }
}

impl FromStr for StableId {
    type Err = IdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() != 32 {
            return Err(IdError::InvalidText);
        }
        u128::from_str_radix(value, 16)
            .map(Self)
            .map_err(|_| IdError::InvalidText)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IdError {
    InvalidText,
    InvalidValue,
    Exhausted,
}

impl fmt::Display for IdError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidText => formatter.write_str("stable id must be 32 hexadecimal characters"),
            Self::InvalidValue => {
                formatter.write_str("stable id requires a nonzero namespace and counter")
            }
            Self::Exhausted => formatter.write_str("stable id namespace is exhausted"),
        }
    }
}

impl std::error::Error for IdError {}

/// Monotonic stable-id allocator for one persisted namespace.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdGenerator {
    namespace: u64,
    next_counter: u64,
    exhausted: bool,
}

impl IdGenerator {
    #[must_use]
    pub const fn new(namespace: u64) -> Self {
        Self {
            namespace,
            next_counter: 1,
            exhausted: false,
        }
    }

    #[must_use]
    pub const fn namespace(&self) -> u64 {
        self.namespace
    }

    #[must_use]
    pub const fn next_counter(&self) -> u64 {
        self.next_counter
    }

    #[must_use]
    pub const fn is_exhausted(&self) -> bool {
        self.exhausted
    }

    pub fn next_id(&mut self) -> Result<StableId, IdError> {
        if self.namespace == 0 {
            return Err(IdError::InvalidValue);
        }
        if self.exhausted {
            return Err(IdError::Exhausted);
        }

        let id = StableId::from_parts(self.namespace, self.next_counter);
        if self.next_counter == u64::MAX {
            self.exhausted = true;
        } else {
            self.next_counter += 1;
        }
        Ok(id)
    }

    /// Observes an externally supplied object id without risking reuse by this
    /// replica's allocator. Foreign replica ids never move the local counter.
    pub fn observe(&mut self, id: StableId) -> Result<(), IdError> {
        if id.namespace() == 0 || id.counter() == 0 {
            return Err(IdError::InvalidValue);
        }
        if id.namespace() != self.namespace || id.counter() < self.next_counter {
            return Ok(());
        }
        if id.counter() == u64::MAX {
            self.next_counter = u64::MAX;
            self.exhausted = true;
        } else {
            self.next_counter = id.counter() + 1;
        }
        Ok(())
    }

    pub(crate) const fn from_snapshot(namespace: u64, next_counter: u64, exhausted: bool) -> Self {
        Self {
            namespace,
            next_counter,
            exhausted,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{IdGenerator, StableId};

    #[test]
    fn ids_round_trip_as_fixed_hex() {
        let id = StableId::from_parts(0x1234, 0x9876);
        let text = id.to_string();
        assert_eq!(text.len(), 32);
        assert_eq!(text.parse::<StableId>(), Ok(id));
    }

    #[test]
    fn generator_is_monotonic_and_namespaced() {
        let mut generator = IdGenerator::new(42);
        let first = generator.next_id().expect("first id");
        let second = generator.next_id().expect("second id");
        assert_eq!(first.namespace(), 42);
        assert_eq!(first.counter(), 1);
        assert_eq!(second.counter(), 2);
        assert!(second > first);
        assert_eq!(
            IdGenerator::new(0).next_id(),
            Err(super::IdError::InvalidValue)
        );
    }

    #[test]
    fn observing_ids_advances_only_the_matching_namespace() {
        let mut generator = IdGenerator::new(42);
        generator
            .observe(StableId::from_parts(7, 10_000))
            .expect("foreign id");
        assert_eq!(generator.next_counter(), 1);
        generator
            .observe(StableId::from_parts(42, 50))
            .expect("local id");
        assert_eq!(generator.next_counter(), 51);
        assert_eq!(generator.next_id().expect("next").counter(), 51);
        assert_eq!(
            generator.observe(StableId::from_parts(0, 1)),
            Err(super::IdError::InvalidValue)
        );
        assert_eq!(
            generator.observe(StableId::from_parts(42, 0)),
            Err(super::IdError::InvalidValue)
        );
    }
}
