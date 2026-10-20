//! Store file formats parsed in Rust and exposed to providers through `ctx.formats`.

pub mod binary_vdf;
pub mod vdf;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum FormatError {
    #[error("unexpected end of input")]
    Eof,
    #[error("line {line}: {msg}")]
    Syntax { line: usize, msg: String },
    #[error("offset {offset}: {msg}")]
    Binary { offset: usize, msg: String },
}
