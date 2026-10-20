//! Valve's text KeyValues format (`.vdf`, `.acf`), parsed to JSON objects of strings.
//!
//! ```text
//! "AppState"
//! {
//!     "appid"   "620"
//!     "name"    "Portal 2"     // comment
//!     "thing"   "x"  [$WIN32]  // conditional: kept only when it holds on Windows
//! }
//! ```

use serde_json::{Map, Value};

use super::FormatError;

#[derive(Debug, PartialEq)]
enum Tok {
    Open,
    Close,
    Str(String),
    Cond(String),
}

struct Lexer<'a> {
    chars: std::iter::Peekable<std::str::Chars<'a>>,
    line: usize,
}

impl Lexer<'_> {
    fn err(&self, msg: impl Into<String>) -> FormatError {
        FormatError::Syntax { line: self.line, msg: msg.into() }
    }

    fn next(&mut self) -> Result<Option<Tok>, FormatError> {
        loop {
            match self.chars.peek().copied() {
                None => return Ok(None),
                Some('\n') => {
                    self.line += 1;
                    self.chars.next();
                }
                Some(c) if c.is_whitespace() || c == '\u{feff}' => {
                    self.chars.next();
                }
                Some('/') => {
                    self.chars.next();
                    if self.chars.peek() == Some(&'/') {
                        while self.chars.peek().is_some_and(|&c| c != '\n') {
                            self.chars.next();
                        }
                    } else {
                        return Ok(Some(Tok::Str(self.bare(String::from("/")))));
                    }
                }
                Some('{') => {
                    self.chars.next();
                    return Ok(Some(Tok::Open));
                }
                Some('}') => {
                    self.chars.next();
                    return Ok(Some(Tok::Close));
                }
                Some('"') => {
                    self.chars.next();
                    return self.quoted().map(|s| Some(Tok::Str(s)));
                }
                Some('[') => {
                    self.chars.next();
                    let mut s = String::new();
                    loop {
                        match self.chars.next() {
                            Some(']') => break,
                            Some('\n') | None => return Err(self.err("unterminated [condition]")),
                            Some(c) => s.push(c),
                        }
                    }
                    return Ok(Some(Tok::Cond(s)));
                }
                Some(_) => return Ok(Some(Tok::Str(self.bare(String::new())))),
            }
        }
    }

    fn quoted(&mut self) -> Result<String, FormatError> {
        let mut s = String::new();
        loop {
            match self.chars.next() {
                None => return Err(self.err("unterminated string")),
                Some('"') => return Ok(s),
                Some('\\') => match self.chars.next() {
                    Some('n') => s.push('\n'),
                    Some('t') => s.push('\t'),
                    Some('\\') => s.push('\\'),
                    Some('"') => s.push('"'),
                    // Unknown escapes are kept verbatim: some files contain lone backslashes.
                    Some(c) => {
                        s.push('\\');
                        s.push(c);
                    }
                    None => return Err(self.err("unterminated string")),
                },
                Some(c) => {
                    if c == '\n' {
                        self.line += 1;
                    }
                    s.push(c);
                }
            }
        }
    }

    fn bare(&mut self, mut s: String) -> String {
        while let Some(&c) = self.chars.peek() {
            if c.is_whitespace() || matches!(c, '{' | '}' | '"' | '[') {
                break;
            }
            s.push(c);
            self.chars.next();
        }
        s
    }
}

/// Evaluates `$WIN32`, `!$OSX`, `$WIN32||$LINUX`, `$X&&$Y` for a Windows host.
fn condition_holds(cond: &str) -> bool {
    cond.split("||").any(|alt| {
        alt.split("&&").all(|term| {
            let term = term.trim();
            let (neg, name) = match term.strip_prefix('!') {
                Some(rest) => (true, rest.trim()),
                None => (false, term),
            };
            let on = matches!(name, "$WIN32" | "$WIN64" | "$WINDOWS");
            on != neg
        })
    })
}

/// Parses a whole document. Returns an object of its top-level keys (usually one, such as
/// `"AppState"`). A repeated key keeps its last value.
pub fn parse(text: &str) -> Result<Value, FormatError> {
    let mut lx = Lexer { chars: text.chars().peekable(), line: 1 };
    let mut pending = None;
    let obj = parse_pairs(&mut lx, &mut pending, false)?;
    Ok(Value::Object(obj))
}

fn parse_pairs(lx: &mut Lexer, pending: &mut Option<Tok>, nested: bool) -> Result<Map<String, Value>, FormatError> {
    let mut map = Map::new();
    loop {
        let tok = match pending.take() {
            Some(t) => Some(t),
            None => lx.next()?,
        };
        let key = match tok {
            None if nested => return Err(FormatError::Eof),
            None => return Ok(map),
            Some(Tok::Close) if nested => return Ok(map),
            Some(Tok::Str(k)) => k,
            Some(t) => return Err(lx.err(format!("expected a key, found {t:?}"))),
        };
        let value = match lx.next()? {
            Some(Tok::Str(v)) => Value::String(v),
            Some(Tok::Open) => Value::Object(parse_pairs(lx, pending, true)?),
            Some(t) => return Err(lx.err(format!("expected a value for \"{key}\", found {t:?}"))),
            None => return Err(FormatError::Eof),
        };
        // An optional condition may follow the value.
        let keep = match lx.next()? {
            Some(Tok::Cond(c)) => condition_holds(&c),
            other => {
                *pending = other;
                true
            }
        };
        if keep {
            map.insert(key, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn appmanifest() {
        let text = "\"AppState\"\n{\n\t\"appid\"\t\t\"620\"\n\t\"name\"\t\t\"Portal 2\"\n\t\"StateFlags\"\t\t\"4\"\n\t\"UserConfig\"\n\t{\n\t\t\"language\"\t\t\"english\"\n\t}\n}\n";
        let v = parse(text).unwrap();
        assert_eq!(v["AppState"]["name"], "Portal 2");
        assert_eq!(v["AppState"]["UserConfig"]["language"], "english");
    }

    #[test]
    fn escapes_and_windows_paths() {
        let v = parse(r#""a" { "path" "D:\\SteamLibrary" "q" "say \"hi\"\n" }"#).unwrap();
        assert_eq!(v["a"]["path"], "D:\\SteamLibrary");
        assert_eq!(v["a"]["q"], "say \"hi\"\n");
    }

    #[test]
    fn comments_unquoted_tokens_and_bom() {
        let v = parse("\u{feff}// header\nroot { key value // trailing\n other \"x\" }").unwrap();
        assert_eq!(v, json!({ "root": { "key": "value", "other": "x" } }));
    }

    #[test]
    fn conditionals() {
        let v = parse(r#""r" { "a" "win" [$WIN32] "b" "mac" [$OSX] "c" "notmac" [!$OSX] "d" "either" [$LINUX||$WINDOWS] }"#).unwrap();
        assert_eq!(v, json!({ "r": { "a": "win", "c": "notmac", "d": "either" } }));
    }

    #[test]
    fn duplicate_keys_keep_last_and_multiple_roots() {
        let v = parse(r#""a" "1" "a" "2" "b" { }"#).unwrap();
        assert_eq!(v, json!({ "a": "2", "b": {} }));
    }

    #[test]
    fn errors_report_lines() {
        assert_eq!(parse("\"a\" {\n \"b\" \"c\"\n").unwrap_err(), FormatError::Eof);
        let e = parse("\"a\"\n\"b\" \"unterminated").unwrap_err();
        assert!(matches!(e, FormatError::Syntax { line: 2, .. }), "{e:?}");
        assert!(parse("}").is_err());
    }
}
