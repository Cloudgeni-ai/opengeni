use crate::CellCoord;

use super::{FormulaEngineError, FormulaLimits};

const EXCEL_MAX_ROWS: u32 = 1_048_576;
const EXCEL_MAX_COLUMNS: u32 = 16_384;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ParsedError {
    DivideByZero,
    Value,
    Reference,
    Name,
    Number,
    NotAvailable,
    Cycle,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum ParsedValue {
    Boolean(bool),
    Number(f64),
    Text(String),
    Error(ParsedError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ParsedUnaryOperator {
    Plus,
    Minus,
    Percent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ParsedBinaryOperator {
    Add,
    Subtract,
    Multiply,
    Divide,
    Power,
    Concatenate,
    Equal,
    NotEqual,
    Less,
    Greater,
    LessOrEqual,
    GreaterOrEqual,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ParsedReference {
    pub(super) sheet_name: Option<String>,
    pub(super) start: CellCoord,
    pub(super) end: CellCoord,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum ParsedExpr {
    Constant(ParsedValue),
    Reference(ParsedReference),
    Range(ParsedReference),
    Unary {
        operator: ParsedUnaryOperator,
        operand: Box<ParsedExpr>,
    },
    Binary {
        operator: ParsedBinaryOperator,
        left: Box<ParsedExpr>,
        right: Box<ParsedExpr>,
    },
    Sequence {
        first: Box<ParsedExpr>,
        rest: Vec<(ParsedBinaryOperator, ParsedExpr)>,
    },
    Call {
        name: String,
        arguments: Vec<ParsedExpr>,
    },
}

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Number(f64),
    Text(String),
    Word(String),
    Cell(Option<CellCoord>),
    Error(ParsedError),
    Operator(OperatorToken),
    Punctuation(Punctuation),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OperatorToken {
    Add,
    Subtract,
    Multiply,
    Divide,
    Power,
    Concatenate,
    Equal,
    NotEqual,
    Less,
    Greater,
    LessOrEqual,
    GreaterOrEqual,
    Percent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Punctuation {
    LeftParenthesis,
    RightParenthesis,
    Comma,
    Colon,
    Bang,
}

enum ParseIssue {
    Syntax(ParsedError),
    Limit(FormulaEngineError),
}

impl From<FormulaEngineError> for ParseIssue {
    fn from(value: FormulaEngineError) -> Self {
        Self::Limit(value)
    }
}

pub(super) fn parse_formula(
    source: &str,
    limits: &FormulaLimits,
) -> Result<ParsedExpr, FormulaEngineError> {
    if source.len() > limits.max_formula_bytes {
        return Err(FormulaEngineError::Limit {
            resource: "formula bytes",
            actual: source.len(),
            maximum: limits.max_formula_bytes,
        });
    }
    let expression = source.strip_prefix('=').unwrap_or(source);
    let tokens = match tokenize(expression, limits.max_tokens) {
        Ok(tokens) => tokens,
        Err(FormulaEngineError::FormulaSyntax { .. }) => {
            return Ok(ParsedExpr::Constant(ParsedValue::Error(ParsedError::Value)))
        }
        Err(error) => return Err(error),
    };
    let mut parser = Parser {
        tokens,
        index: 0,
        nesting_depth: 0,
        limits,
    };
    match parser.parse() {
        Ok(expression) => {
            validate_expression_depth(&expression, limits.max_nesting_depth)?;
            Ok(expression)
        }
        Err(ParseIssue::Syntax(error)) => Ok(ParsedExpr::Constant(ParsedValue::Error(error))),
        Err(ParseIssue::Limit(error)) => Err(error),
    }
}

fn validate_expression_depth(
    expression: &ParsedExpr,
    maximum: usize,
) -> Result<(), FormulaEngineError> {
    let mut stack = vec![(expression, 1usize)];
    while let Some((expression, depth)) = stack.pop() {
        if depth > maximum {
            return Err(FormulaEngineError::Limit {
                resource: "formula nesting depth",
                actual: depth,
                maximum,
            });
        }
        let next = depth.saturating_add(1);
        match expression {
            ParsedExpr::Unary { operand, .. } => stack.push((operand, next)),
            ParsedExpr::Binary { left, right, .. } => {
                stack.push((right, next));
                stack.push((left, next));
            }
            ParsedExpr::Sequence { first, rest } => {
                for (_, expression) in rest.iter().rev() {
                    stack.push((expression, next));
                }
                stack.push((first, next));
            }
            ParsedExpr::Call { arguments, .. } => {
                stack.extend(arguments.iter().rev().map(|argument| (argument, next)));
            }
            ParsedExpr::Constant(_) | ParsedExpr::Reference(_) | ParsedExpr::Range(_) => {}
        }
    }
    Ok(())
}

fn sequence(first: ParsedExpr, rest: Vec<(ParsedBinaryOperator, ParsedExpr)>) -> ParsedExpr {
    if rest.is_empty() {
        first
    } else {
        ParsedExpr::Sequence {
            first: Box::new(first),
            rest,
        }
    }
}

/// Rewrites only syntactic sheet qualifiers, never string literals or names.
/// The replacement is always quoted so spaces and punctuation remain valid.
pub(super) fn rewrite_sheet_references(
    source: &str,
    previous_name: &str,
    next_name: &str,
) -> Option<String> {
    let replacement = format!("'{}'!", next_name.replace('\'', "''"));
    rewrite_sheet_qualifiers(source, previous_name, &replacement)
}

pub(super) fn rewrite_deleted_sheet_references(source: &str, deleted_name: &str) -> Option<String> {
    rewrite_sheet_qualifiers(source, deleted_name, "#REF!")
}

fn rewrite_sheet_qualifiers(
    source: &str,
    previous_name: &str,
    replacement: &str,
) -> Option<String> {
    let bytes = source.as_bytes();
    let mut output = String::with_capacity(source.len().saturating_add(replacement.len()));
    let mut copy_start = 0usize;
    let mut index = 0usize;
    let mut changed = false;

    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                if let Some((_value, end)) = scan_quoted(source, index, b'"') {
                    index = end;
                } else {
                    break;
                }
            }
            b'\'' => {
                let Some((name, end)) = scan_quoted(source, index, b'\'') else {
                    break;
                };
                if bytes.get(end) == Some(&b'!') && sheet_names_equal(&name, previous_name) {
                    output.push_str(&source[copy_start..index]);
                    output.push_str(replacement);
                    index = end + 1;
                    copy_start = index;
                    changed = true;
                } else {
                    index = end;
                }
            }
            _ => {
                if let Some(end) = scan_word(bytes, index) {
                    if bytes.get(end) == Some(&b'!')
                        && sheet_names_equal(&source[index..end], previous_name)
                    {
                        output.push_str(&source[copy_start..index]);
                        output.push_str(replacement);
                        index = end + 1;
                        copy_start = index;
                        changed = true;
                    } else {
                        index = end;
                    }
                } else {
                    index += source[index..].chars().next().map_or(1, char::len_utf8);
                }
            }
        }
    }
    if !changed {
        return None;
    }
    output.push_str(&source[copy_start..]);
    Some(output)
}

fn sheet_names_equal(left: &str, right: &str) -> bool {
    left.chars()
        .flat_map(char::to_lowercase)
        .eq(right.chars().flat_map(char::to_lowercase))
}

struct Parser<'a> {
    tokens: Vec<Token>,
    index: usize,
    nesting_depth: usize,
    limits: &'a FormulaLimits,
}

impl Parser<'_> {
    fn parse(&mut self) -> Result<ParsedExpr, ParseIssue> {
        let expression = self.comparison()?;
        if self.peek().is_some() {
            return Err(ParseIssue::Syntax(ParsedError::Value));
        }
        Ok(expression)
    }

    fn comparison(&mut self) -> Result<ParsedExpr, ParseIssue> {
        let first = self.concatenation()?;
        let mut rest = Vec::new();
        loop {
            let operator = match self.peek() {
                Some(Token::Operator(OperatorToken::Equal)) => ParsedBinaryOperator::Equal,
                Some(Token::Operator(OperatorToken::NotEqual)) => ParsedBinaryOperator::NotEqual,
                Some(Token::Operator(OperatorToken::Less)) => ParsedBinaryOperator::Less,
                Some(Token::Operator(OperatorToken::Greater)) => ParsedBinaryOperator::Greater,
                Some(Token::Operator(OperatorToken::LessOrEqual)) => {
                    ParsedBinaryOperator::LessOrEqual
                }
                Some(Token::Operator(OperatorToken::GreaterOrEqual)) => {
                    ParsedBinaryOperator::GreaterOrEqual
                }
                _ => break,
            };
            self.consume();
            let right = self.concatenation()?;
            rest.push((operator, right));
        }
        Ok(sequence(first, rest))
    }

    fn concatenation(&mut self) -> Result<ParsedExpr, ParseIssue> {
        let first = self.additive()?;
        let mut rest = Vec::new();
        while matches!(
            self.peek(),
            Some(Token::Operator(OperatorToken::Concatenate))
        ) {
            self.consume();
            let right = self.additive()?;
            rest.push((ParsedBinaryOperator::Concatenate, right));
        }
        Ok(sequence(first, rest))
    }

    fn additive(&mut self) -> Result<ParsedExpr, ParseIssue> {
        let first = self.multiplicative()?;
        let mut rest = Vec::new();
        loop {
            let operator = match self.peek() {
                Some(Token::Operator(OperatorToken::Add)) => ParsedBinaryOperator::Add,
                Some(Token::Operator(OperatorToken::Subtract)) => ParsedBinaryOperator::Subtract,
                _ => break,
            };
            self.consume();
            let right = self.multiplicative()?;
            rest.push((operator, right));
        }
        Ok(sequence(first, rest))
    }

    fn multiplicative(&mut self) -> Result<ParsedExpr, ParseIssue> {
        let first = self.power()?;
        let mut rest = Vec::new();
        loop {
            let operator = match self.peek() {
                Some(Token::Operator(OperatorToken::Multiply)) => ParsedBinaryOperator::Multiply,
                Some(Token::Operator(OperatorToken::Divide)) => ParsedBinaryOperator::Divide,
                _ => break,
            };
            self.consume();
            let right = self.power()?;
            rest.push((operator, right));
        }
        Ok(sequence(first, rest))
    }

    fn power(&mut self) -> Result<ParsedExpr, ParseIssue> {
        let left = self.unary()?;
        if !matches!(self.peek(), Some(Token::Operator(OperatorToken::Power))) {
            return Ok(left);
        }
        self.consume();
        let right = self.nested(Self::power)?;
        Ok(ParsedExpr::Binary {
            operator: ParsedBinaryOperator::Power,
            left: Box::new(left),
            right: Box::new(right),
        })
    }

    fn unary(&mut self) -> Result<ParsedExpr, ParseIssue> {
        let prefix = match self.peek() {
            Some(Token::Operator(OperatorToken::Add)) => Some(ParsedUnaryOperator::Plus),
            Some(Token::Operator(OperatorToken::Subtract)) => Some(ParsedUnaryOperator::Minus),
            _ => None,
        };
        if let Some(operator) = prefix {
            self.consume();
            let operand = self.nested(Self::unary)?;
            return Ok(ParsedExpr::Unary {
                operator,
                operand: Box::new(operand),
            });
        }
        let value = self.primary()?;
        if matches!(self.peek(), Some(Token::Operator(OperatorToken::Percent))) {
            self.consume();
            return Ok(ParsedExpr::Unary {
                operator: ParsedUnaryOperator::Percent,
                operand: Box::new(value),
            });
        }
        Ok(value)
    }

    fn primary(&mut self) -> Result<ParsedExpr, ParseIssue> {
        let token = self
            .consume()
            .ok_or(ParseIssue::Syntax(ParsedError::Value))?;
        match token {
            Token::Number(value) => Ok(ParsedExpr::Constant(if value.is_finite() {
                ParsedValue::Number(if value == 0.0 { 0.0 } else { value })
            } else {
                ParsedValue::Error(ParsedError::Number)
            })),
            Token::Text(value) => Ok(ParsedExpr::Constant(ParsedValue::Text(value))),
            Token::Error(value) => {
                // Sheet deletion canonicalizes qualifiers to Excel's
                // `#REF!A1` spelling. Consume the orphaned address/range as
                // part of the reference error so it can never bind by name.
                if value == ParsedError::Reference && matches!(self.peek(), Some(Token::Cell(_))) {
                    self.consume();
                    if matches!(self.peek(), Some(Token::Punctuation(Punctuation::Colon))) {
                        self.consume();
                        if matches!(self.peek(), Some(Token::Cell(_))) {
                            self.consume();
                        }
                    }
                }
                Ok(ParsedExpr::Constant(ParsedValue::Error(value)))
            }
            Token::Cell(address) => self.reference(None, address),
            Token::Word(word) => {
                if matches!(self.peek(), Some(Token::Punctuation(Punctuation::Bang))) {
                    self.consume();
                    let address = match self.consume() {
                        Some(Token::Cell(address)) => address,
                        _ => return Err(ParseIssue::Syntax(ParsedError::Reference)),
                    };
                    return self.reference(Some(word), address);
                }
                if matches!(
                    self.peek(),
                    Some(Token::Punctuation(Punctuation::LeftParenthesis))
                ) {
                    return self.function_call(word);
                }
                if word.eq_ignore_ascii_case("TRUE") {
                    return Ok(ParsedExpr::Constant(ParsedValue::Boolean(true)));
                }
                if word.eq_ignore_ascii_case("FALSE") {
                    return Ok(ParsedExpr::Constant(ParsedValue::Boolean(false)));
                }
                Ok(ParsedExpr::Constant(ParsedValue::Error(ParsedError::Name)))
            }
            Token::Punctuation(Punctuation::LeftParenthesis) => {
                let value = self.nested(Self::comparison)?;
                self.expect(Punctuation::RightParenthesis)?;
                Ok(value)
            }
            _ => Err(ParseIssue::Syntax(ParsedError::Value)),
        }
    }

    fn reference(
        &mut self,
        sheet_name: Option<String>,
        start: Option<CellCoord>,
    ) -> Result<ParsedExpr, ParseIssue> {
        let Some(start) = start else {
            return Ok(ParsedExpr::Constant(ParsedValue::Error(
                ParsedError::Reference,
            )));
        };
        if !matches!(self.peek(), Some(Token::Punctuation(Punctuation::Colon))) {
            return Ok(ParsedExpr::Reference(ParsedReference {
                sheet_name,
                start,
                end: start,
            }));
        }
        self.consume();
        let end = match self.consume() {
            Some(Token::Cell(Some(address))) => address,
            Some(Token::Cell(None)) => {
                return Ok(ParsedExpr::Constant(ParsedValue::Error(
                    ParsedError::Reference,
                )))
            }
            _ => return Err(ParseIssue::Syntax(ParsedError::Reference)),
        };
        let start_row = start.row.min(end.row);
        let end_row = start.row.max(end.row);
        let start_column = start.column.min(end.column);
        let end_column = start.column.max(end.column);
        let row_count = (end_row - start_row + 1) as usize;
        let column_count = (end_column - start_column + 1) as usize;
        let cells = row_count
            .checked_mul(column_count)
            .ok_or(FormulaEngineError::Limit {
                resource: "formula range cells",
                actual: usize::MAX,
                maximum: self.limits.max_range_cells,
            })?;
        if cells > self.limits.max_range_cells {
            return Err(FormulaEngineError::Limit {
                resource: "formula range cells",
                actual: cells,
                maximum: self.limits.max_range_cells,
            }
            .into());
        }
        Ok(ParsedExpr::Range(ParsedReference {
            sheet_name,
            start: CellCoord::new(start_row, start_column),
            end: CellCoord::new(end_row, end_column),
        }))
    }

    fn function_call(&mut self, name: String) -> Result<ParsedExpr, ParseIssue> {
        self.expect(Punctuation::LeftParenthesis)?;
        let mut arguments = Vec::new();
        if !matches!(
            self.peek(),
            Some(Token::Punctuation(Punctuation::RightParenthesis))
        ) {
            loop {
                let actual = arguments.len().saturating_add(1);
                if actual > self.limits.max_function_arguments {
                    return Err(FormulaEngineError::Limit {
                        resource: "formula function arguments",
                        actual,
                        maximum: self.limits.max_function_arguments,
                    }
                    .into());
                }
                arguments.push(self.nested(Self::comparison)?);
                if !matches!(self.peek(), Some(Token::Punctuation(Punctuation::Comma))) {
                    break;
                }
                self.consume();
            }
        }
        self.expect(Punctuation::RightParenthesis)?;
        Ok(ParsedExpr::Call { name, arguments })
    }

    fn nested(
        &mut self,
        parser: fn(&mut Self) -> Result<ParsedExpr, ParseIssue>,
    ) -> Result<ParsedExpr, ParseIssue> {
        let actual = self.nesting_depth.saturating_add(1);
        if actual > self.limits.max_nesting_depth {
            return Err(FormulaEngineError::Limit {
                resource: "formula nesting depth",
                actual,
                maximum: self.limits.max_nesting_depth,
            }
            .into());
        }
        self.nesting_depth = actual;
        let result = parser(self);
        self.nesting_depth -= 1;
        result
    }

    fn expect(&mut self, punctuation: Punctuation) -> Result<(), ParseIssue> {
        if self.consume() == Some(Token::Punctuation(punctuation)) {
            Ok(())
        } else {
            Err(ParseIssue::Syntax(ParsedError::Value))
        }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.index)
    }

    fn consume(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.index).cloned();
        self.index = self.index.saturating_add(1);
        token
    }
}

fn tokenize(input: &str, maximum: usize) -> Result<Vec<Token>, FormulaEngineError> {
    let bytes = input.as_bytes();
    let mut tokens = Vec::new();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        let start = index;
        let token = match bytes[index] {
            b'"' => {
                let (value, end) = scan_quoted(input, index, b'"')
                    .ok_or(FormulaEngineError::FormulaSyntax { error: "#VALUE!" })?;
                index = end;
                Token::Text(value)
            }
            b'\'' => {
                let (value, end) = scan_quoted(input, index, b'\'')
                    .ok_or(FormulaEngineError::FormulaSyntax { error: "#VALUE!" })?;
                index = end;
                Token::Word(value)
            }
            b'#' => {
                let remaining = &input[index..];
                let mut matched = None;
                for (text, error) in [
                    ("#DIV/0!", ParsedError::DivideByZero),
                    ("#NAME?", ParsedError::Name),
                    ("#VALUE!", ParsedError::Value),
                    ("#CYCLE!", ParsedError::Cycle),
                    ("#REF!", ParsedError::Reference),
                    ("#NUM!", ParsedError::Number),
                    ("#N/A", ParsedError::NotAvailable),
                ] {
                    if remaining
                        .get(..text.len())
                        .is_some_and(|candidate| candidate.eq_ignore_ascii_case(text))
                    {
                        matched = Some((text.len(), error));
                        break;
                    }
                }
                let Some((length, error)) = matched else {
                    return Ok(vec![Token::Error(ParsedError::Value)]);
                };
                index += length;
                Token::Error(error)
            }
            b'0'..=b'9' | b'.'
                if bytes[index].is_ascii_digit()
                    || bytes.get(index + 1).is_some_and(u8::is_ascii_digit) =>
            {
                index = scan_number(bytes, index);
                let value = input[start..index].parse::<f64>().unwrap_or(f64::NAN);
                Token::Number(value)
            }
            _ => {
                if let Some((end, address)) = scan_cell(bytes, index) {
                    if bytes.get(end) != Some(&b'!') {
                        index = end;
                        Token::Cell(address)
                    } else {
                        let end = scan_word(bytes, index)
                            .ok_or(FormulaEngineError::FormulaSyntax { error: "#VALUE!" })?;
                        index = end;
                        Token::Word(input[start..index].to_owned())
                    }
                } else if let Some(end) = scan_word(bytes, index) {
                    index = end;
                    Token::Word(input[start..index].to_owned())
                } else {
                    let (token, width) = match bytes.get(index..index.saturating_add(2)) {
                        Some(b"<=") => (Token::Operator(OperatorToken::LessOrEqual), 2),
                        Some(b">=") => (Token::Operator(OperatorToken::GreaterOrEqual), 2),
                        Some(b"<>") => (Token::Operator(OperatorToken::NotEqual), 2),
                        _ => match bytes[index] {
                            b'+' => (Token::Operator(OperatorToken::Add), 1),
                            b'-' => (Token::Operator(OperatorToken::Subtract), 1),
                            b'*' => (Token::Operator(OperatorToken::Multiply), 1),
                            b'/' => (Token::Operator(OperatorToken::Divide), 1),
                            b'^' => (Token::Operator(OperatorToken::Power), 1),
                            b'&' => (Token::Operator(OperatorToken::Concatenate), 1),
                            b'=' => (Token::Operator(OperatorToken::Equal), 1),
                            b'<' => (Token::Operator(OperatorToken::Less), 1),
                            b'>' => (Token::Operator(OperatorToken::Greater), 1),
                            b'%' => (Token::Operator(OperatorToken::Percent), 1),
                            b'(' => (Token::Punctuation(Punctuation::LeftParenthesis), 1),
                            b')' => (Token::Punctuation(Punctuation::RightParenthesis), 1),
                            b',' => (Token::Punctuation(Punctuation::Comma), 1),
                            b':' => (Token::Punctuation(Punctuation::Colon), 1),
                            b'!' => (Token::Punctuation(Punctuation::Bang), 1),
                            _ => return Ok(vec![Token::Error(ParsedError::Value)]),
                        },
                    };
                    index += width;
                    token
                }
            }
        };
        let actual = tokens.len().saturating_add(1);
        if actual > maximum {
            return Err(FormulaEngineError::Limit {
                resource: "formula tokens",
                actual,
                maximum,
            });
        }
        tokens.push(token);
    }
    Ok(tokens)
}

fn scan_quoted(input: &str, start: usize, quote: u8) -> Option<(String, usize)> {
    let bytes = input.as_bytes();
    let mut index = start + 1;
    let mut part_start = index;
    let mut value = String::new();
    while index < bytes.len() {
        if bytes[index] != quote {
            index += 1;
            continue;
        }
        value.push_str(&input[part_start..index]);
        if bytes.get(index + 1) == Some(&quote) {
            value.push(quote as char);
            index += 2;
            part_start = index;
            continue;
        }
        return Some((value, index + 1));
    }
    None
}

fn scan_number(bytes: &[u8], start: usize) -> usize {
    let mut index = start;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
    }
    if matches!(bytes.get(index), Some(b'e' | b'E')) {
        let exponent = index;
        index += 1;
        if matches!(bytes.get(index), Some(b'+' | b'-')) {
            index += 1;
        }
        let digits = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == digits {
            return exponent;
        }
    }
    index
}

fn scan_word(bytes: &[u8], start: usize) -> Option<usize> {
    if !matches!(bytes.get(start), Some(b'a'..=b'z' | b'A'..=b'Z' | b'_')) {
        return None;
    }
    let mut index = start + 1;
    while matches!(
        bytes.get(index),
        Some(b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'.')
    ) {
        index += 1;
    }
    Some(index)
}

fn scan_cell(bytes: &[u8], start: usize) -> Option<(usize, Option<CellCoord>)> {
    let mut index = start;
    if bytes.get(index) == Some(&b'$') {
        index += 1;
    }
    let column_start = index;
    while matches!(bytes.get(index), Some(b'a'..=b'z' | b'A'..=b'Z')) && index - column_start < 3 {
        index += 1;
    }
    let column_letters = index - column_start;
    if column_letters == 0 || matches!(bytes.get(index), Some(b'a'..=b'z' | b'A'..=b'Z')) {
        return None;
    }
    if bytes.get(index) == Some(&b'$') {
        index += 1;
    }
    let row_start = index;
    if !matches!(bytes.get(index), Some(b'1'..=b'9')) {
        return None;
    }
    index += 1;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    if matches!(
        bytes.get(index),
        Some(b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'.')
    ) {
        return None;
    }

    let mut column = 0u32;
    for letter in &bytes[column_start..column_start + column_letters] {
        column = column
            .saturating_mul(26)
            .saturating_add((letter.to_ascii_uppercase() - b'A' + 1) as u32);
    }
    let mut row = 0u32;
    for digit in &bytes[row_start..index] {
        row = row.saturating_mul(10).saturating_add((digit - b'0') as u32);
    }
    let address = if column == 0 || column > EXCEL_MAX_COLUMNS || row == 0 || row > EXCEL_MAX_ROWS {
        None
    } else {
        Some(CellCoord::new(row - 1, column - 1))
    };
    Some((index, address))
}

#[cfg(test)]
mod tests {
    use super::{
        parse_formula, rewrite_sheet_references, ParsedBinaryOperator, ParsedError, ParsedExpr,
        ParsedValue,
    };
    use crate::formula::FormulaLimits;

    #[test]
    fn parser_preserves_precedence_and_quoted_references() {
        let limits = FormulaLimits::default();
        let parsed = parse_formula("='Revenue Q1'!$A$1+2*3", &limits).expect("formula");
        let ParsedExpr::Sequence { first, rest } = parsed else {
            panic!("expected addition");
        };
        assert!(matches!(*first, ParsedExpr::Reference(_)));
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].0, ParsedBinaryOperator::Add);
        assert!(matches!(
            &rest[0].1,
            ParsedExpr::Sequence { rest, .. }
                if rest.len() == 1 && rest[0].0 == ParsedBinaryOperator::Multiply
        ));
    }

    #[test]
    fn syntax_faults_compile_to_values_but_limits_fail_closed() {
        let limits = FormulaLimits::default();
        assert_eq!(
            parse_formula("=1+", &limits).expect("syntax value"),
            ParsedExpr::Constant(ParsedValue::Error(ParsedError::Value))
        );
        let oversized = "x".repeat(limits.max_formula_bytes + 1);
        assert!(parse_formula(&oversized, &limits).is_err());
    }

    #[test]
    fn sheet_reference_rewrite_is_lexical_and_quotes_the_new_name() {
        let source = "='Old Name'!A1+Old.Name!B2+\"Old Name!C3\"";
        assert_eq!(
            rewrite_sheet_references(source, "old name", "New 'Name'"),
            Some("='New ''Name'''!A1+Old.Name!B2+\"Old Name!C3\"".to_owned())
        );
        assert_eq!(
            rewrite_sheet_references("=Old.Name!A1", "old.name", "New"),
            Some("='New'!A1".to_owned())
        );
        assert_eq!(rewrite_sheet_references("=\"Old!A1\"", "Old", "New"), None);
    }
}
