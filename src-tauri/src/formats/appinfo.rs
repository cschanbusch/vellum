//! Steam's `appcache/appinfo.vdf`: the client's local copy of every app's store data, so
//! developer, publisher, genres and release dates are available offline.
//!
//! The file is a header, then one record per app, then (v29) a string table:
//!
//! - header: magic `u32` (`0x07564427` v27, `…28` v28, `…29` v29), universe `u32`, and in v29
//!   the string table's offset `i64`;
//! - record: appid `u32` (0 ends the list), size `u32` (bytes left in the record), info state
//!   `u32`, last updated `u32`, access token `u64`, SHA-1 `[20]`, change number `u32`, and from
//!   v28 a second SHA-1 `[20]`; then the app's binary KeyValues (keys from the string table in v29);
//! - string table (v29): count `u32`, then that many NUL-terminated strings.
//!
//! Only the fields providers need are returned, for the apps asked for.

use std::collections::HashSet;

use serde_json::{json, Map, Value};

use super::binary_vdf::Reader;
use super::FormatError;

const V27: u32 = 0x0756_4427;
const V28: u32 = 0x0756_4428;
const V29: u32 = 0x0756_4429;

fn err(offset: usize, msg: impl Into<String>) -> FormatError {
    FormatError::Binary { offset, msg: msg.into() }
}

fn u32_at(b: &[u8], at: usize) -> Result<u32, FormatError> {
    b.get(at..at + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap())).ok_or(FormatError::Eof)
}

fn string_table(b: &[u8], at: usize) -> Result<Vec<String>, FormatError> {
    let count = u32_at(b, at)? as usize;
    let mut r = Reader { bytes: b, pos: at + 4, keys: None };
    // Each string takes at least one byte, which bounds a corrupt count.
    if count > b.len() {
        return Err(err(at, "string table count is larger than the file"));
    }
    (0..count).map(|_| r.cstr()).collect()
}

/// The provider-facing subset of one app's data.
fn pick(info: &Map<String, Value>) -> Value {
    let root = info.get("appinfo").and_then(Value::as_object).unwrap_or(info);
    let common = root.get("common").and_then(Value::as_object);
    let extended = root.get("extended").and_then(Value::as_object);
    let get = |m: Option<&Map<String, Value>>, k: &str| m.and_then(|m| m.get(k)).cloned().unwrap_or(Value::Null);
    let mut developers = Vec::new();
    let mut publishers = Vec::new();
    if let Some(assoc) = common.and_then(|c| c.get("associations")).and_then(Value::as_object) {
        for a in assoc.values() {
            let (Some(t), Some(n)) = (a.get("type").and_then(Value::as_str), a.get("name").and_then(Value::as_str)) else { continue };
            match t {
                "developer" => developers.push(n.to_string()),
                "publisher" => publishers.push(n.to_string()),
                _ => {}
            }
        }
    }
    // Older records name them in `extended` instead.
    if developers.is_empty() {
        if let Some(d) = extended.and_then(|e| e.get("developer")).and_then(Value::as_str) {
            developers.push(d.to_string());
        }
    }
    if publishers.is_empty() {
        if let Some(p) = extended.and_then(|e| e.get("publisher")).and_then(Value::as_str) {
            publishers.push(p.to_string());
        }
    }
    // Genres are a map of position -> genre id; keep them in order.
    let mut genres: Vec<(u64, Value)> = common
        .and_then(|c| c.get("genres"))
        .and_then(Value::as_object)
        .map(|g| g.iter().map(|(k, v)| (k.parse().unwrap_or(u64::MAX), v.clone())).collect())
        .unwrap_or_default();
    genres.sort_by_key(|(k, _)| *k);
    let release = ["steam_release_date", "original_release_date"]
        .iter()
        .find_map(|k| {
            let v = get(common, k);
            v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).filter(|&t| t > 0)
        })
        .map_or(Value::Null, Value::from);
    json!({
        "name": get(common, "name"),
        "type": get(common, "type"),
        "developers": developers,
        "publishers": publishers,
        "genres": genres.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
        "primaryGenre": get(common, "primary_genre"),
        "releaseDate": release,
    })
}

/// Parses `appinfo.vdf`, returning `{ "<appid>": { name, type, developers, publishers, genres,
/// primaryGenre, releaseDate } }` for the apps in `wanted` (all apps when `wanted` is empty).
/// A record that fails to parse is skipped; a bad header is an error.
pub fn parse(bytes: &[u8], wanted: &HashSet<u32>) -> Result<Value, FormatError> {
    let magic = u32_at(bytes, 0)?;
    // Records run from `pos` to `end`: the end of the file, or (v29) the string table.
    let (mut pos, end, table, second_sha) = match magic {
        V27 => (8, bytes.len(), None, false),
        V28 => (8, bytes.len(), None, true),
        V29 => {
            let off = bytes.get(8..16).map(|s| i64::from_le_bytes(s.try_into().unwrap())).ok_or(FormatError::Eof)?;
            let off = usize::try_from(off).ok().filter(|&o| o <= bytes.len()).ok_or_else(|| err(8, "string table offset outside the file"))?;
            (16, off, Some(string_table(bytes, off)?), true)
        }
        other => return Err(err(0, format!("unknown appinfo version 0x{other:08x}"))),
    };
    let fixed = 4 + 4 + 8 + 20 + 4 + if second_sha { 20 } else { 0 };
    let mut out = Map::new();
    while pos + 4 <= end {
        let appid = u32_at(bytes, pos)?;
        if appid == 0 {
            break;
        }
        let size = u32_at(bytes, pos + 4)? as usize;
        let body = pos + 8;
        let next = body.checked_add(size).filter(|&n| n <= end).ok_or_else(|| err(pos, format!("app {appid} runs past the end")))?;
        if wanted.is_empty() || wanted.contains(&appid) {
            let mut r = Reader { bytes: &bytes[..next], pos: body + fixed, keys: table.as_deref() };
            if let Ok(info) = r.map(true) {
                out.insert(appid.to_string(), pick(&info));
            }
        }
        pos = next;
    }
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAP: u8 = 0x00;
    const STRING: u8 = 0x01;
    const INT32: u8 = 0x02;
    const END: u8 = 0x08;

    /// Builds a binary KeyValues body with keys as string-table indexes (`table`) or inline.
    struct Kv<'a> {
        out: Vec<u8>,
        table: Option<&'a mut Vec<String>>,
    }

    impl Kv<'_> {
        fn key(&mut self, ty: u8, k: &str) {
            self.out.push(ty);
            match self.table.as_deref_mut() {
                Some(t) => {
                    let i = t.iter().position(|s| s == k).unwrap_or_else(|| {
                        t.push(k.to_string());
                        t.len() - 1
                    });
                    self.out.extend_from_slice(&(i as u32).to_le_bytes());
                }
                None => {
                    self.out.extend_from_slice(k.as_bytes());
                    self.out.push(0);
                }
            }
        }
        fn open(&mut self, k: &str) -> &mut Self {
            self.key(MAP, k);
            self
        }
        fn s(&mut self, k: &str, v: &str) -> &mut Self {
            self.key(STRING, k);
            self.out.extend_from_slice(v.as_bytes());
            self.out.push(0);
            self
        }
        fn i(&mut self, k: &str, v: i32) -> &mut Self {
            self.key(INT32, k);
            self.out.extend_from_slice(&v.to_le_bytes());
            self
        }
        fn close(&mut self) -> &mut Self {
            self.out.push(END);
            self
        }
    }

    fn app_body(kv: &mut Kv, name: &str, dev: &str) {
        kv.open("appinfo").i("appid", 1).open("common").s("name", name).s("type", "Game").i("steam_release_date", 1_347_642_000);
        kv.open("genres").i("1", 28).i("0", 23).close();
        kv.i("primary_genre", 23);
        kv.open("associations").open("0").s("type", "developer").s("name", dev).close().open("1").s("type", "publisher").s("name", "Pub").close().close();
        kv.close().close();
        kv.close(); // end of the record's top level
    }

    fn file(magic: u32, apps: &[(u32, &str, &str)]) -> Vec<u8> {
        let mut table: Vec<String> = Vec::new();
        let v29 = magic == V29;
        let mut records = Vec::new();
        for &(appid, name, dev) in apps {
            let mut kv = Kv { out: Vec::new(), table: if v29 { Some(&mut table) } else { None } };
            app_body(&mut kv, name, dev);
            let mut rec = Vec::new();
            rec.extend_from_slice(&0u32.to_le_bytes()); // info state
            rec.extend_from_slice(&0u32.to_le_bytes()); // last updated
            rec.extend_from_slice(&0u64.to_le_bytes()); // token
            rec.extend_from_slice(&[0; 20]);
            rec.extend_from_slice(&7u32.to_le_bytes()); // change number
            if magic != V27 {
                rec.extend_from_slice(&[0; 20]);
            }
            rec.extend_from_slice(&kv.out);
            records.extend_from_slice(&appid.to_le_bytes());
            records.extend_from_slice(&(rec.len() as u32).to_le_bytes());
            records.extend_from_slice(&rec);
        }
        records.extend_from_slice(&0u32.to_le_bytes());
        let mut out = Vec::new();
        out.extend_from_slice(&magic.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        if v29 {
            let off = 16 + records.len();
            out.extend_from_slice(&(off as i64).to_le_bytes());
            out.extend_from_slice(&records);
            out.extend_from_slice(&(table.len() as u32).to_le_bytes());
            for s in &table {
                out.extend_from_slice(s.as_bytes());
                out.push(0);
            }
        } else {
            out.extend_from_slice(&records);
        }
        out
    }

    #[test]
    fn reads_every_version_and_only_the_apps_asked_for() {
        for magic in [V27, V28, V29] {
            let b = file(magic, &[(10, "Counter-Strike", "Valve"), (212680, "FTL", "Subset Games")]);
            let all = parse(&b, &HashSet::new()).unwrap();
            assert_eq!(all.as_object().unwrap().len(), 2, "{magic:x}");
            let one = parse(&b, &HashSet::from([212680])).unwrap();
            assert_eq!(
                one,
                json!({ "212680": {
                    "name": "FTL", "type": "Game", "developers": ["Subset Games"], "publishers": ["Pub"],
                    "genres": [23, 28], "primaryGenre": 23, "releaseDate": 1_347_642_000u64,
                } }),
                "{magic:x}"
            );
        }
    }

    #[test]
    fn bad_headers_fail_and_bad_records_are_skipped() {
        assert!(matches!(parse(&[1, 2, 3, 4, 0, 0, 0, 0], &HashSet::new()), Err(FormatError::Binary { .. })));
        assert_eq!(parse(&[0x27, 0x44], &HashSet::new()), Err(FormatError::Eof));
        // A record whose size runs past the end is an error, not a panic.
        let mut b = file(V28, &[(10, "A", "B")]);
        b[12] = 0xff;
        b[13] = 0xff;
        assert!(parse(&b, &HashSet::new()).is_err());
    }
}
