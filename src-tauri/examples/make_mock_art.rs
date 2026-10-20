//! Generates the mock provider's art at real resolutions into plugins/providers/mock/art/.
//!
//!   cargo run --release --example make_mock_art [-- <plugins dir>]
//!
//! The titles come from running the mock provider itself in the real host, so the art always
//! matches the games. 80 sets are made; with a larger "Number of games" setting the provider
//! reuses them. A few games deliberately have no cover, hero, logo or header, so placeholder
//! handling can be seen. The art is generated, not committed (see .gitignore).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ab_glyph::{Font, FontRef, PxScale, ScaleFont};
use image::{codecs::jpeg::JpegEncoder, DynamicImage, Rgba, RgbaImage};
use serde_json::{Map, Value};
use vellum_lib::plugins::{self, PluginKind};
use vellum_lib::providers::host::{self, HostEnv, Invocation, Method, RecordingOpener};
use vellum_lib::providers::locations::SystemRegistry;
use vellum_lib::providers::model::ProviderSpec;

pub const SETS: usize = 80;
const FONT: &[u8] = include_bytes!("../../scripts/mock-art/InterDisplay-Bold.ttf");

/// Which art a game deliberately lacks (mirrors plugins/providers/mock/provider.js).
fn missing(i: usize, kind: &str) -> bool {
    match kind {
        "cover" => i % 13 == 12,
        "hero" => i % 7 == 3,
        "logo" => i % 11 == 5,
        "header" => i % 17 == 9,
        _ => false,
    }
}

fn hash(s: &str) -> u32 {
    s.bytes().fold(0x811c_9dc5u32, |h, b| (h ^ b as u32).wrapping_mul(0x0100_0193))
}

fn hsl(h: f32, s: f32, l: f32) -> [f32; 3] {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = (h.rem_euclid(360.0)) / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    [(r + m) * 255.0, (g + m) * 255.0, (b + m) * 255.0]
}

fn mix(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

fn px(c: [f32; 3]) -> Rgba<u8> {
    Rgba([c[0].clamp(0.0, 255.0) as u8, c[1].clamp(0.0, 255.0) as u8, c[2].clamp(0.0, 255.0) as u8, 255])
}

struct Palette {
    sky_top: [f32; 3],
    sky_bottom: [f32; 3],
    sun: [f32; 3],
    hills: [[f32; 3]; 3],
    accent: [f32; 3],
    seed: u32,
}

fn palette(title: &str) -> Palette {
    let h = hash(title);
    let hue = (h % 360) as f32;
    let hue2 = hue + 25.0 + ((h >> 9) % 70) as f32;
    let night = (h >> 4) % 3 == 0;
    let (top_l, bottom_l) = if night { (0.08, 0.22) } else { (0.28, 0.62) };
    Palette {
        sky_top: hsl(hue2 + 180.0, 0.45, top_l),
        sky_bottom: hsl(hue2, 0.55, bottom_l),
        sun: hsl(hue2 + 20.0, 0.8, if night { 0.85 } else { 0.78 }),
        hills: [hsl(hue, 0.35, 0.34), hsl(hue, 0.4, 0.22), hsl(hue, 0.45, 0.11)],
        accent: hsl(hue2, 0.75, 0.62),
        seed: h,
    }
}

/// Sky gradient, a sun, and three layers of rolling hills. `scale` keeps detail consistent
/// across sizes; `horizon` is the fraction of the height where the hills start.
fn landscape(w: u32, h: u32, p: &Palette, horizon: f32) -> RgbaImage {
    let mut img = RgbaImage::new(w, h);
    let s = p.seed;
    let sun_x = w as f32 * (0.2 + ((s >> 3) % 60) as f32 / 100.0);
    let sun_y = h as f32 * (horizon - 0.12);
    let sun_r = (w.min(h) as f32) * 0.11;
    let layers: Vec<(f32, f32, f32, f32)> = (0..3)
        .map(|k| {
            let base = horizon + 0.1 * k as f32;
            let amp = 0.05 + 0.03 * ((s >> (5 + k)) % 3) as f32;
            let freq = 1.5 + ((s >> (8 + k * 2)) % 4) as f32;
            let phase = ((s >> (11 + k)) % 628) as f32 / 100.0;
            (base, amp, freq, phase)
        })
        .collect();
    for y in 0..h {
        let t = y as f32 / h as f32;
        let sky = mix(p.sky_top, p.sky_bottom, (t / horizon).min(1.0));
        for x in 0..w {
            let fx = x as f32;
            let fy = y as f32;
            let mut c = sky;
            let d = ((fx - sun_x).powi(2) + (fy - sun_y).powi(2)).sqrt();
            if d < sun_r {
                c = p.sun;
            } else if d < sun_r * 3.0 {
                c = mix(p.sun, c, ((d - sun_r) / (sun_r * 2.0)).powf(0.5));
            }
            let u = fx / w as f32;
            for (k, (base, amp, freq, phase)) in layers.iter().enumerate() {
                let ridge = base + amp * ((u * freq * std::f32::consts::TAU + phase).sin() * 0.7 + (u * freq * 2.3 * std::f32::consts::TAU + phase * 1.7).sin() * 0.3);
                if t > ridge {
                    c = p.hills[k];
                }
            }
            img.put_pixel(x, y, px(c));
        }
    }
    img
}

/// Darkens toward the bottom so text stays readable.
fn shade_bottom(img: &mut RgbaImage, from: f32, strength: f32) {
    let h = img.height() as f32;
    for (_, y, p) in img.enumerate_pixels_mut() {
        let t = ((y as f32 / h - from) / (1.0 - from)).clamp(0.0, 1.0) * strength;
        for ch in 0..3 {
            p.0[ch] = (p.0[ch] as f32 * (1.0 - t)) as u8;
        }
    }
}

struct Text<'a> {
    font: &'a FontRef<'a>,
}

impl Text<'_> {
    fn width(&self, size: f32, s: &str) -> f32 {
        let f = self.font.as_scaled(PxScale::from(size));
        let mut w = 0.0;
        let mut last = None;
        for c in s.chars() {
            let id = f.glyph_id(c);
            if let Some(l) = last {
                w += f.kern(l, id);
            }
            w += f.h_advance(id);
            last = Some(id);
        }
        w
    }

    /// Draws one line with its baseline at `y`, blending `color` by glyph coverage.
    fn draw(&self, img: &mut RgbaImage, size: f32, x: f32, y: f32, s: &str, color: [u8; 4]) {
        let f = self.font.as_scaled(PxScale::from(size));
        let mut caret = x;
        let mut last = None;
        for c in s.chars() {
            let id = f.glyph_id(c);
            if let Some(l) = last {
                caret += f.kern(l, id);
            }
            let glyph = id.with_scale_and_position(size, ab_glyph::point(caret, y));
            caret += f.h_advance(id);
            last = Some(id);
            let Some(outline) = self.font.outline_glyph(glyph) else { continue };
            let b = outline.px_bounds();
            outline.draw(|gx, gy, cov| {
                let (px_, py_) = (b.min.x as i32 + gx as i32, b.min.y as i32 + gy as i32);
                if px_ < 0 || py_ < 0 || px_ >= img.width() as i32 || py_ >= img.height() as i32 {
                    return;
                }
                let p = img.get_pixel_mut(px_ as u32, py_ as u32);
                let a = cov * color[3] as f32 / 255.0;
                for ch in 0..3 {
                    p.0[ch] = (p.0[ch] as f32 * (1.0 - a) + color[ch] as f32 * a) as u8;
                }
                p.0[3] = (p.0[3] as f32 + (255.0 - p.0[3] as f32) * a) as u8;
            });
        }
    }

    /// Greedy wrap to `max_w` pixels.
    fn wrap(&self, size: f32, s: &str, max_w: f32) -> Vec<String> {
        let mut lines = Vec::new();
        let mut line = String::new();
        for word in s.split_whitespace() {
            let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
            if !line.is_empty() && self.width(size, &candidate) > max_w {
                lines.push(std::mem::take(&mut line));
                line = word.to_string();
            } else {
                line = candidate;
            }
        }
        if !line.is_empty() {
            lines.push(line);
        }
        lines
    }

    /// Wrapped block: shrinks the size until it fits `max_lines`; returns the block height.
    fn block(&self, img: &mut RgbaImage, s: &str, mut size: f32, x: f32, bottom: f32, max_w: f32, max_lines: usize, center: bool) -> f32 {
        let mut lines = self.wrap(size, s, max_w);
        while (lines.len() > max_lines || lines.iter().any(|l| self.width(size, l) > max_w)) && size > 20.0 {
            size *= 0.9;
            lines = self.wrap(size, s, max_w);
        }
        let lh = size * 1.08;
        let top = bottom - lh * lines.len() as f32;
        for (i, l) in lines.iter().enumerate() {
            let w = self.width(size, l);
            let lx = if center { x + (max_w - w) / 2.0 } else { x };
            let y = top + lh * (i as f32 + 0.8);
            self.draw(img, size, lx + size * 0.03, y + size * 0.04, l, [0, 0, 0, 110]);
            self.draw(img, size, lx, y, l, [255, 255, 255, 255]);
        }
        lh * lines.len() as f32
    }
}

fn save_jpg(img: &RgbaImage, path: &Path) {
    let rgb = DynamicImage::ImageRgba8(img.clone()).to_rgb8();
    let mut out = std::fs::File::create(path).unwrap();
    JpegEncoder::new_with_quality(&mut out, 85).encode_image(&rgb).unwrap();
}

fn initials(title: &str) -> String {
    title.split_whitespace().filter(|w| w.chars().next().is_some_and(char::is_alphanumeric)).take(2).filter_map(|w| w.chars().next()).collect::<String>().to_uppercase()
}

fn make_set(dir: &Path, i: usize, title: &str, studio: &str, t: &Text) {
    std::fs::create_dir_all(dir).unwrap();
    let p = palette(title);

    if !missing(i, "cover") {
        let mut img = landscape(1200, 1800, &p, 0.48);
        shade_bottom(&mut img, 0.45, 0.75);
        t.draw(&mut img, 34.0, 80.0, 120.0, &studio.to_uppercase(), [255, 255, 255, 200]);
        t.block(&mut img, title, 150.0, 80.0, 1640.0, 1040.0, 4, false);
        let bar = px(p.accent);
        for y in 1690..1700 {
            for x in 80..300 {
                img.put_pixel(x, y, bar);
            }
        }
        save_jpg(&img, &dir.join("cover.jpg"));
    }
    if !missing(i, "hero") {
        let img = landscape(3840, 1240, &p, 0.55);
        save_jpg(&img, &dir.join("hero.jpg"));
    }
    if !missing(i, "header") {
        let mut img = landscape(920, 430, &p, 0.5);
        shade_bottom(&mut img, 0.3, 0.7);
        t.block(&mut img, title, 70.0, 40.0, 390.0, 760.0, 2, false);
        save_jpg(&img, &dir.join("header.jpg"));
    }
    if !missing(i, "logo") {
        // Transparent, sized to the text: up to 1280 wide.
        let size = 150.0;
        let lines = t.wrap(size, title, 1200.0);
        let lines = &lines[..lines.len().min(2)];
        let h = (size * 1.08 * lines.len() as f32 + 60.0) as u32;
        // Cropped to the text, left-aligned, like real logos.
        let text_w = lines.iter().map(|l| t.width(size, l)).fold(0.0, f32::max);
        let w = ((text_w + 40.0) as u32).clamp(200, 1280);
        let mut img = RgbaImage::from_pixel(w, h, Rgba([0, 0, 0, 0]));
        t.block(&mut img, &lines.join(" "), size, 10.0, h as f32 - 40.0, w as f32 - 20.0, 2, false);
        let a = px(p.accent);
        for y in h - 22..h - 14 {
            for x in 14..174 {
                img.put_pixel(x, y, a);
            }
        }
        img.save(dir.join("logo.png")).unwrap();
    }
    let mut icon = landscape(256, 256, &p, 0.62);
    let ini = initials(title);
    let w = t.width(110.0, &ini);
    t.draw(&mut icon, 110.0, (256.0 - w) / 2.0, 168.0, &ini, [255, 255, 255, 255]);
    icon.save(dir.join("icon.png")).unwrap();
}

fn main() {
    let plugins_dir = std::env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins"));
    let mock_dir = plugins_dir.join("providers").join("mock");
    let rec = plugins::load(&mock_dir, PluginKind::Provider);
    let mut saved = Map::new();
    saved.insert("count".into(), Value::from(SETS));
    let spec = ProviderSpec::from_record(&rec, &saved).expect("the mock provider manifest is invalid");
    let env = HostEnv { registry: Arc::new(SystemRegistry), opener: Arc::new(RecordingOpener::default()) };
    let inv = Invocation { spec: &spec, locations: &BTreeMap::new(), derived: &[], env: &env, timeout: None };
    let out = host::invoke(&inv, Method::Scan, None).expect("mock scan failed");
    let games = out.value["games"].as_array().expect("games").clone();

    let font = FontRef::try_from_slice(FONT).unwrap();
    let text = Text { font: &font };
    let art_dir = mock_dir.join("art");
    let started = std::time::Instant::now();
    let chunks: Vec<_> = games.iter().enumerate().collect::<Vec<_>>();
    std::thread::scope(|scope| {
        let n = std::thread::available_parallelism().map_or(4, |n| n.get());
        for part in chunks.chunks(chunks.len().div_ceil(n)) {
            let (text, art_dir) = (&text, &art_dir);
            scope.spawn(move || {
                for (i, g) in part {
                    let id = g["sourceId"].as_str().unwrap();
                    let title = g["title"].as_str().unwrap();
                    let studio = g["metadata"]["developer"].as_str().unwrap_or("");
                    make_set(&art_dir.join(id), *i, title, studio, text);
                }
            });
        }
    });
    println!("Made {} art sets in {} in {:.1}s", games.len(), art_dir.display(), started.elapsed().as_secs_f32());
}
