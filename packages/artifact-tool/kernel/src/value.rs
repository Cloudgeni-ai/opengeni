use core::fmt;

/// A finite spreadsheet number with a canonical zero representation.
#[derive(Clone, Copy, Debug, PartialEq, PartialOrd)]
#[repr(transparent)]
pub struct Number(f64);

impl Number {
    pub fn new(value: f64) -> Result<Self, ValueError> {
        if !value.is_finite() {
            return Err(ValueError::NonFiniteNumber);
        }
        // Canonicalize negative zero so equal model state always snapshots to
        // equal bytes regardless of the arithmetic path that produced it.
        Ok(Self(if value == 0.0 { 0.0 } else { value }))
    }

    #[must_use]
    pub const fn get(self) -> f64 {
        self.0
    }

    pub(crate) fn from_snapshot_bits(bits: u64) -> Result<Self, ValueError> {
        Self::new(f64::from_bits(bits))
    }
}

impl TryFrom<f64> for Number {
    type Error = ValueError;

    fn try_from(value: f64) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

/// One canonical JavaScript-compatible UTC instant, stored as integer Unix
/// milliseconds. The bound is exactly the ECMAScript `Date` time-clip range,
/// so native, WASM, and TypeScript projections cannot disagree about whether a
/// persisted date is representable.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[repr(transparent)]
pub struct DateValue(i64);

impl DateValue {
    pub const MAX_MILLISECONDS: i64 = 8_640_000_000_000_000;
    pub const MIN_MILLISECONDS: i64 = -Self::MAX_MILLISECONDS;
    const MILLISECONDS_PER_DAY: i64 = 86_400_000;

    pub fn new(milliseconds: i64) -> Result<Self, ValueError> {
        if !(Self::MIN_MILLISECONDS..=Self::MAX_MILLISECONDS).contains(&milliseconds) {
            return Err(ValueError::DateOutOfRange);
        }
        Ok(Self(milliseconds))
    }

    #[must_use]
    pub const fn milliseconds(self) -> i64 {
        self.0
    }

    pub(crate) fn from_unix_days(days: i64) -> Result<Self, ValueError> {
        days.checked_mul(Self::MILLISECONDS_PER_DAY)
            .ok_or(ValueError::DateOutOfRange)
            .and_then(Self::new)
    }

    #[must_use]
    pub(crate) fn excel_serial(self) -> f64 {
        self.0 as f64 / Self::MILLISECONDS_PER_DAY as f64 + 25_569.0
    }

    #[must_use]
    pub(crate) fn utc_date(self) -> (i64, i64, i64) {
        civil_from_days(self.0.div_euclid(Self::MILLISECONDS_PER_DAY))
    }

    #[must_use]
    pub fn to_iso_string(self) -> String {
        let days = self.0.div_euclid(Self::MILLISECONDS_PER_DAY);
        let day_milliseconds = self.0.rem_euclid(Self::MILLISECONDS_PER_DAY);
        let (year, month, day) = civil_from_days(days);
        let hour = day_milliseconds / 3_600_000;
        let minute = day_milliseconds % 3_600_000 / 60_000;
        let second = day_milliseconds % 60_000 / 1_000;
        let millisecond = day_milliseconds % 1_000;
        let year = if (0..=9_999).contains(&year) {
            format!("{year:04}")
        } else {
            format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs())
        };
        format!("{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millisecond:03}Z")
    }
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    (year + i64::from(month <= 2), month, day)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FormulaError {
    Null,
    DivideByZero,
    Value,
    Reference,
    Name,
    Number,
    NotAvailable,
    Spill,
    Calculation,
    Custom(String),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum CellValue {
    #[default]
    Empty,
    Boolean(bool),
    Number(Number),
    Date(DateValue),
    Text(String),
    Error(FormulaError),
}

/// Authored cell state. This is the only cell shape accepted by commands,
/// collaboration registers, and canonical state encoders. Formula results are
/// deliberately unrepresentable here.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AuthoredCellContent {
    kind: AuthoredCellKind,
}

#[derive(Clone, Debug, PartialEq)]
enum AuthoredCellKind {
    Value(CellValue),
    Formula(String),
}

impl Default for AuthoredCellKind {
    fn default() -> Self {
        Self::Value(CellValue::Empty)
    }
}

impl AuthoredCellContent {
    #[must_use]
    pub const fn empty() -> Self {
        Self::from_value(CellValue::Empty)
    }

    #[must_use]
    pub const fn from_value(value: CellValue) -> Self {
        Self {
            kind: AuthoredCellKind::Value(value),
        }
    }

    pub fn formula(source: impl Into<String>) -> Result<Self, ValueError> {
        let source = source.into();
        if source.is_empty() {
            return Err(ValueError::EmptyFormula);
        }
        Ok(Self {
            kind: AuthoredCellKind::Formula(source),
        })
    }

    #[must_use]
    pub fn literal_value(&self) -> Option<&CellValue> {
        match &self.kind {
            AuthoredCellKind::Value(value) => Some(value),
            AuthoredCellKind::Formula(_) => None,
        }
    }

    #[must_use]
    pub fn formula_source(&self) -> Option<&str> {
        match &self.kind {
            AuthoredCellKind::Value(_) => None,
            AuthoredCellKind::Formula(source) => Some(source),
        }
    }

    #[must_use]
    pub const fn is_empty(&self) -> bool {
        matches!(self.kind, AuthoredCellKind::Value(CellValue::Empty))
    }

    #[must_use]
    pub fn materialize(&self) -> Cell {
        match &self.kind {
            AuthoredCellKind::Value(value) => Cell::from_value(value.clone()),
            AuthoredCellKind::Formula(_) => Cell {
                authored: self.clone(),
                projected_formula_value: Some(CellValue::Empty),
            },
        }
    }
}

/// Materialized workbook cell. Literal values are stored once; only formulas
/// have a disposable calculated projection alongside their authored source.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Cell {
    authored: AuthoredCellContent,
    projected_formula_value: Option<CellValue>,
}

impl Cell {
    #[must_use]
    pub const fn empty() -> Self {
        Self::from_value(CellValue::Empty)
    }

    #[must_use]
    pub const fn from_value(value: CellValue) -> Self {
        Self {
            authored: AuthoredCellContent::from_value(value),
            projected_formula_value: None,
        }
    }

    /// Creates an authored formula with an empty calculated projection.
    pub fn formula(source: impl Into<String>) -> Result<Self, ValueError> {
        Ok(AuthoredCellContent::formula(source)?.materialize())
    }

    /// Creates a materialized/query formula cell. Authored command blocks
    /// convert this back to [`AuthoredCellContent`] and discard the projection.
    pub(crate) fn from_formula_projection(
        source: impl Into<String>,
        projected_value: CellValue,
    ) -> Result<Self, ValueError> {
        Ok(Self {
            authored: AuthoredCellContent::formula(source)?,
            projected_formula_value: Some(projected_value),
        })
    }

    #[must_use]
    pub fn value(&self) -> &CellValue {
        self.authored.literal_value().unwrap_or_else(|| {
            self.projected_formula_value
                .as_ref()
                .expect("formula cells always own a calculated projection")
        })
    }

    #[must_use]
    pub fn formula_source(&self) -> Option<&str> {
        self.authored.formula_source()
    }

    #[must_use]
    pub const fn authored(&self) -> &AuthoredCellContent {
        &self.authored
    }

    #[must_use]
    pub fn into_authored(self) -> AuthoredCellContent {
        self.authored
    }

    #[must_use]
    pub const fn is_empty(&self) -> bool {
        self.authored.is_empty()
    }
}

impl From<Cell> for AuthoredCellContent {
    fn from(cell: Cell) -> Self {
        cell.into_authored()
    }
}

impl From<AuthoredCellContent> for Cell {
    fn from(content: AuthoredCellContent) -> Self {
        content.materialize()
    }
}

impl From<bool> for Cell {
    fn from(value: bool) -> Self {
        Self::from_value(CellValue::Boolean(value))
    }
}

impl From<String> for Cell {
    fn from(value: String) -> Self {
        Self::from_value(CellValue::Text(value))
    }
}

impl From<&str> for Cell {
    fn from(value: &str) -> Self {
        Self::from_value(CellValue::Text(value.to_owned()))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ValueError {
    NonFiniteNumber,
    DateOutOfRange,
    EmptyFormula,
}

impl fmt::Display for ValueError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonFiniteNumber => formatter.write_str("cell numbers must be finite"),
            Self::DateOutOfRange => {
                formatter.write_str("cell date is outside the ECMAScript range")
            }
            Self::EmptyFormula => formatter.write_str("formula source must not be empty"),
        }
    }
}

impl std::error::Error for ValueError {}

#[cfg(test)]
mod tests {
    use super::{DateValue, Number};

    #[test]
    fn numbers_reject_non_finite_and_canonicalize_zero() {
        assert!(Number::new(f64::NAN).is_err());
        assert!(Number::new(f64::INFINITY).is_err());
        assert_eq!(Number::new(-0.0).expect("zero").get().to_bits(), 0);
    }

    #[test]
    fn dates_use_the_exact_javascript_range_and_iso_projection() {
        assert!(DateValue::new(DateValue::MIN_MILLISECONDS - 1).is_err());
        assert!(DateValue::new(DateValue::MAX_MILLISECONDS + 1).is_err());
        assert_eq!(
            DateValue::new(0).expect("epoch").to_iso_string(),
            "1970-01-01T00:00:00.000Z"
        );
        assert_eq!(
            DateValue::new(-1).expect("before epoch").to_iso_string(),
            "1969-12-31T23:59:59.999Z"
        );
        assert_eq!(
            DateValue::new(DateValue::MIN_MILLISECONDS)
                .expect("minimum")
                .to_iso_string(),
            "-271821-04-20T00:00:00.000Z"
        );
        assert_eq!(
            DateValue::new(DateValue::MAX_MILLISECONDS)
                .expect("maximum")
                .to_iso_string(),
            "+275760-09-13T00:00:00.000Z"
        );
    }
}
