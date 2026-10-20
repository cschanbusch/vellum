//! Generated placeholder art: a deterministic two-tone SVG from a hash of the title.
//! A port of sdk/src/placeholder.ts; tests/fixtures/placeholders.json keeps the two identical.

use std::fmt::Write;

struct Layout {
    w: u32,
    h: u32,
    /// Characters per line before wrapping (0 = no title text), font size, max lines.
    chars: usize,
    size: u32,
    lines: usize,
}

fn layout(kind: &str) -> Layout {
    match kind {
        "cover" => Layout { w: 600, h: 900, chars: 14, size: 64, lines: 5 },
        "hero" => Layout { w: 1920, h: 620, chars: 0, size: 0, lines: 0 },
        "header" => Layout { w: 920, h: 430, chars: 22, size: 54, lines: 3 },
        "logo" => Layout { w: 1280, h: 400, chars: 24, size: 96, lines: 2 },
        _ => Layout { w: 256, h: 256, chars: 0, size: 0, lines: 0 },
    }
}

const FONT: &str = "Inter, 'Segoe UI', system-ui, sans-serif";

/// FNV-1a over the UTF-8 bytes.
pub fn hash_title(title: &str) -> u32 {
    title.bytes().fold(0x811c_9dc5u32, |h, b| (h ^ b as u32).wrapping_mul(0x0100_0193))
}

fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' | '<' | '>' | '"' | '\'' => {
                let _ = write!(out, "&#{};", c as u32);
            }
            _ => out.push(c),
        }
    }
    out
}

/// Greedy word wrap by character count; long words are broken; overflow ends in "…".
pub fn wrap(title: &str, chars: usize, max_lines: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut line: Vec<char> = Vec::new();
    for word in title.split_whitespace() {
        let mut w: Vec<char> = word.chars().collect();
        if !line.is_empty() && line.len() + 1 + w.len() > chars {
            lines.push(line.drain(..).collect());
        }
        if !line.is_empty() {
            line.push(' ');
        }
        while w.len() > chars - line.len() {
            let take = chars - line.len();
            line.extend(w.drain(..take));
            lines.push(line.drain(..).collect());
        }
        line.extend(w);
    }
    if !line.is_empty() {
        lines.push(line.into_iter().collect());
    }
    if lines.len() > max_lines {
        lines.truncate(max_lines);
        let last: String = lines[max_lines - 1].chars().take(chars.saturating_sub(1)).collect();
        lines[max_lines - 1] = format!("{}…", last.trim_end());
    }
    lines
}

fn initials(title: &str) -> String {
    title
        .split_whitespace()
        .filter(|w| w.chars().next().is_some_and(char::is_alphanumeric))
        .take(2)
        .flat_map(|w| w.chars().next().unwrap().to_uppercase())
        .collect()
}

/// JavaScript's Math.round for the non-negative values used here.
fn round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

pub fn svg(title: &str, kind: &str) -> String {
    let l = layout(kind);
    let h = hash_title(title);
    let hue1 = h % 360;
    let hue2 = (hue1 + 30 + ((h >> 9) % 60)) % 360;
    let cx = (h >> 3) % l.w;
    let cy = (h >> 13) % l.h;
    let r = (l.w.max(l.h) as f64 * 0.6).floor() as u32;
    let mut s = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">"#, w = l.w, h = l.h);
    if kind != "logo" {
        let _ = write!(
            s,
            r#"<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl({hue1},45%,20%)"/><stop offset="1" stop-color="hsl({hue2},55%,36%)"/></linearGradient></defs><rect width="{w}" height="{hh}" fill="url(#g)"/><circle cx="{cx}" cy="{cy}" r="{r}" fill="hsl({hue2},60%,60%)" fill-opacity="0.12"/>"#,
            w = l.w,
            hh = l.h,
        );
    }
    let text = if kind == "icon" {
        vec![initials(title)]
    } else if l.chars > 0 {
        wrap(title, l.chars, l.lines)
    } else {
        Vec::new()
    };
    let size = if kind == "icon" { 110 } else { l.size };
    if text.first().is_some_and(|t| !t.is_empty()) {
        let line_height = round(size as f64 * 1.15);
        let first = round(l.h as f64 / 2.0 - ((text.len() as i64 - 1) * line_height) as f64 / 2.0 + size as f64 * 0.35);
        let _ = write!(
            s,
            r##"<g font-family="{FONT}" font-weight="700" font-size="{size}" fill="#ffffff" fill-opacity="0.92" text-anchor="middle">"##
        );
        for (i, t) in text.iter().enumerate() {
            let _ = write!(s, r#"<text x="{}" y="{}">{}</text>"#, l.w / 2, first + i as i64 * line_height, escape_xml(t));
        }
        s.push_str("</g>");
    }
    s.push_str("</svg>");
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn wraps_like_the_sdk() {
        assert_eq!(wrap("The Elder Scrolls V: Skyrim Special Edition", 14, 5), ["The Elder", "Scrolls V:", "Skyrim Special", "Edition"]);
        assert_eq!(wrap("Supercalifragilistic", 8, 5), ["Supercal", "ifragili", "stic"]);
        assert_eq!(wrap("a b c d e f", 1, 3), ["a", "b", "…"]);
    }

    /// The SDK's copy must produce byte-identical SVG (the Vitest suite checks the same file).
    #[test]
    fn matches_the_shared_fixture() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/placeholders.json");
        let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(cases.len() >= 10);
        for c in cases {
            let (title, kind, want) = (c["title"].as_str().unwrap(), c["kind"].as_str().unwrap(), c["svg"].as_str().unwrap());
            assert_eq!(svg(title, kind), want, "{title} / {kind}");
        }
    }
}
