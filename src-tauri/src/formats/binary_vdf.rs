//! Valve's binary KeyValues format (e.g. `shortcuts.vdf`), parsed to JSON.
//! Each field is `<type byte><NUL-terminated key><payload>`; maps end with 0x08.

use serde_json::{Map, Number, Value};

use super::FormatError;

const MAP: u8 = 0x00;
const STRING: u8 = 0x01;
const INT32: u8 = 0x02;
const FLOAT32: u8 = 0x03;
const POINTER: u8 = 0x04;
const COLOR: u8 = 0x06;
const UINT64: u8 = 0x07;
const END: u8 = 0x08;
const INT64: u8 = 0x0A;

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn err(&self, msg: impl Into<String>) -> FormatError {
        FormatError::Binary { offset: self.pos, msg: msg.into() }
    }

    fn take(&mut self, n: usize) -> Result<&[u8], FormatError> {
        let end = self.pos.checked_add(n).filter(|&e| e <= self.bytes.len()).ok_or(FormatError::Eof)?;
        let s = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    fn cstr(&mut self) -> Result<String, FormatError> {
        let rest = &self.bytes[self.pos..];
        let len = rest.iter().position(|&b| b == 0).ok_or(FormatError::Eof)?;
        let s = String::from_utf8_lossy(&rest[..len]).into_owned();
        self.pos += len + 1;
        Ok(s)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], FormatError> {
        Ok(self.take(N)?.try_into().unwrap())
    }

    fn map(&mut self, top: bool) -> Result<Map<String, Value>, FormatError> {
        let mut map = Map::new();
        loop {
            let Some(&ty) = self.bytes.get(self.pos) else {
                return if top { Ok(map) } else { Err(FormatError::Eof) };
            };
            self.pos += 1;
            if ty == END {
                return Ok(map);
            }
            let key = self.cstr()?;
            let value = match ty {
                MAP => Value::Object(self.map(false)?),
                STRING => Value::String(self.cstr()?),
                INT32 | POINTER | COLOR => Value::from(i32::from_le_bytes(self.array()?)),
                FLOAT32 => Number::from_f64(f32::from_le_bytes(self.array()?) as f64).map_or(Value::Null, Value::Number),
                UINT64 => Value::from(u64::from_le_bytes(self.array()?)),
                INT64 => Value::from(i64::from_le_bytes(self.array()?)),
                other => return Err(self.err(format!("unknown field type 0x{other:02x}"))),
            };
            map.insert(key, value);
        }
    }
}

pub fn parse(bytes: &[u8]) -> Result<Value, FormatError> {
    let mut r = Reader { bytes, pos: 0 };
    Ok(Value::Object(r.map(true)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn field(out: &mut Vec<u8>, ty: u8, key: &str) {
        out.push(ty);
        out.extend_from_slice(key.as_bytes());
        out.push(0);
    }

    #[test]
    fn shortcuts_like_document() {
        let mut b = Vec::new();
        field(&mut b, MAP, "shortcuts");
        field(&mut b, MAP, "0");
        field(&mut b, INT32, "appid");
        b.extend_from_slice(&(-123i32).to_le_bytes());
        field(&mut b, STRING, "AppName");
        b.extend_from_slice(b"Emulator\0");
        field(&mut b, UINT64, "big");
        b.extend_from_slice(&(1u64 << 40).to_le_bytes());
        field(&mut b, FLOAT32, "f");
        b.extend_from_slice(&1.5f32.to_le_bytes());
        b.extend_from_slice(&[END, END, END]);
        let v = parse(&b).unwrap();
        assert_eq!(
            v,
            json!({ "shortcuts": { "0": { "appid": -123, "AppName": "Emulator", "big": 1u64 << 40, "f": 1.5 } } })
        );
    }

    #[test]
    fn truncated_and_unknown_types_fail_cleanly() {
        let mut b = Vec::new();
        field(&mut b, MAP, "a");
        field(&mut b, INT32, "n");
        b.extend_from_slice(&[1, 2]);
        assert_eq!(parse(&b).unwrap_err(), FormatError::Eof);
        let mut b = Vec::new();
        field(&mut b, 0x42, "x");
        assert!(matches!(parse(&b).unwrap_err(), FormatError::Binary { .. }));
    }
}
