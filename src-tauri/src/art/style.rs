//! Art styles: game art redrawn as a pencil sketch or a watercolor, so skins can make every
//! cover, hero and icon look hand-made. Applied after resizing; results are cached with the
//! other variants. Both are deterministic, so a cached variant never needs rebuilding.

use image::imageops::{self, FilterType};
use image::{DynamicImage, Rgba, RgbaImage};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ArtStyle {
    /// Monochrome graphite on warm paper.
    Sketch,
    /// Soft washes of colour with pooled pigment at the edges, granulation and paper.
    Watercolor,
}

impl ArtStyle {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "sketch" => Some(ArtStyle::Sketch),
            "watercolor" => Some(ArtStyle::Watercolor),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            ArtStyle::Sketch => "sketch",
            ArtStyle::Watercolor => "watercolor",
        }
    }
}

/// Styles an image. `kind` is the art kind ("cover", "hero", ...): it sets the brush size.
pub fn apply(img: &DynamicImage, style: ArtStyle, kind: &str) -> RgbaImage {
    let rgba = img.to_rgba8();
    let u = unit(rgba.width(), rgba.height(), kind);
    match style {
        ArtStyle::Sketch => sketch(&rgba, u),
        ArtStyle::Watercolor => watercolor(&rgba, u),
    }
}

// ---- helpers ---------------------------------------------------------------------------------

fn luma(p: &Rgba<u8>) -> f32 {
    (0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32) / 255.0
}

/// Smooth value noise in 0..1, stable for a given position and seed.
fn hash(x: i32, y: i32, seed: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(374_761_393) ^ (y as u32).wrapping_mul(668_265_263) ^ seed.wrapping_mul(2_246_822_519);
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    ((h ^ (h >> 16)) & 0xffff) as f32 / 65535.0
}

fn value_noise(x: f32, y: f32, seed: u32) -> f32 {
    let (x0, y0) = (x.floor() as i32, y.floor() as i32);
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let s = |t: f32| t * t * (3.0 - 2.0 * t);
    let (sx, sy) = (s(fx), s(fy));
    let a = hash(x0, y0, seed) + (hash(x0 + 1, y0, seed) - hash(x0, y0, seed)) * sx;
    let b = hash(x0, y0 + 1, seed) + (hash(x0 + 1, y0 + 1, seed) - hash(x0, y0 + 1, seed)) * sx;
    a + (b - a) * sy
}

fn fbm(x: f32, y: f32, seed: u32, octaves: u32) -> f32 {
    let (mut sum, mut amp, mut freq, mut norm) = (0.0, 0.5, 1.0, 0.0);
    for o in 0..octaves {
        sum += amp * value_noise(x * freq, y * freq, seed + o * 101);
        norm += amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    sum / norm
}

/// Brush scale, in pixels per brush unit, so strokes look the same size on screen whatever the
/// resolution. Covers and icons are drawn well below their pixel size, so a 640 px cover gets
/// brush 2. Heroes and headers fill the window at about their pixel size, so a 1920 x 620 hero
/// gets brush 1, which keeps heroes as sharp as the unstyled art.
fn unit(w: u32, h: u32, kind: &str) -> f32 {
    let base = match kind {
        "hero" | "header" => 620.0,
        _ => 320.0,
    };
    (w.min(h) as f32 / base).max(0.5)
}

/// Builds an image band by band across all cores. `f(y0, y1, out)` fills rows y0..y1 of RGBA
/// bytes. Bands are interleaved between threads so uneven bands balance out.
fn par_bands(w: u32, h: u32, f: impl Fn(u32, u32, &mut [u8]) + Sync) -> RgbaImage {
    const BAND: u32 = 32;
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(16);
    let mut work: Vec<Vec<(u32, &mut [u8])>> = (0..threads).map(|_| Vec::new()).collect();
    for (i, chunk) in buf.chunks_mut((BAND * w * 4) as usize).enumerate() {
        work[i % threads].push((i as u32 * BAND, chunk));
    }
    std::thread::scope(|scope| {
        for bands in work {
            let f = &f;
            scope.spawn(move || {
                for (y0, out) in bands {
                    let y1 = y0 + (out.len() / (w as usize * 4)) as u32;
                    f(y0, y1, out);
                }
            });
        }
    });
    RgbaImage::from_raw(w, h, buf).expect("buffer matches the image size")
}

/// `par_bands` for a per-pixel function.
fn par_from_fn(w: u32, h: u32, f: impl Fn(u32, u32) -> Rgba<u8> + Sync) -> RgbaImage {
    par_bands(w, h, |y0, y1, out| {
        let mut i = 0;
        for y in y0..y1 {
            for x in 0..w {
                out[i..i + 4].copy_from_slice(&f(x, y).0);
                i += 4;
            }
        }
    })
}

// ---- pencil sketch ---------------------------------------------------------------------------

/// Classic "colour dodge" sketch: grey divided by its blurred negative leaves only the edges,
/// which become graphite lines; then diagonal hatching in the darks and paper grain.
fn sketch(src: &RgbaImage, u: f32) -> RgbaImage {
    let (w, h) = src.dimensions();
    let gray: Vec<f32> = src.pixels().map(luma).collect();
    let inv = image::GrayImage::from_fn(w, h, |x, y| image::Luma([((1.0 - gray[(y * w + x) as usize]) * 255.0) as u8]));
    let blurred = imageops::blur(&inv, 4.0 * u);

    let paper = [0.965f32, 0.945, 0.905];
    let graphite = [0.16f32, 0.155, 0.15];
    par_from_fn(w, h, |x, y| {
        let i = (y * w + x) as usize;
        let g = gray[i];
        let b = blurred.get_pixel(x, y)[0] as f32 / 255.0;
        // Colour dodge, then deepen the lines.
        let mut v = (g / (1.0 - b + 0.02)).min(1.0);
        v = v.powf(2.2);
        // Hatching: diagonal strokes that appear only in darker tones.
        let fx = x as f32 / u;
        let fy = y as f32 / u;
        let stroke = ((fx + fy) * 0.9 + fbm(fx * 0.05, fy * 0.05, 7, 2) * 6.0).sin() * 0.5 + 0.5;
        let shade = (0.55 - g).max(0.0) * 1.3;
        v -= shade * (stroke - 0.35).max(0.0) * 0.55;
        // Paper tooth.
        v *= 0.94 + 0.06 * fbm(fx * 0.9, fy * 0.9, 3, 2);
        let v = v.clamp(0.0, 1.0);
        let px = |c: usize| ((graphite[c] + (paper[c] - graphite[c]) * v) * 255.0) as u8;
        Rgba([px(0), px(1), px(2), src.get_pixel(x, y)[3]])
    })
}

// ---- watercolor ------------------------------------------------------------------------------

/// Kuwahara filter: each pixel takes the mean of the most uniform of its four quadrants,
/// flattening detail into painterly patches while keeping edges.
fn kuwahara(src: &RgbaImage, r: i32) -> RgbaImage {
    let (w, h) = src.dimensions();
    let (wi, hi) = (w as i32, h as i32);
    let stride = (w + 1) as usize;
    // Each band builds summed-area tables (colour, luminance, luminance squared, in integers)
    // over its own rows plus the radius, so memory stays small even for 4K heroes.
    par_bands(w, h, |y0, y1, out| {
        let top = (y0 as i32 - r).max(0);
        let bottom = (y1 as i32 + r + 1).min(hi);
        let rows = (bottom - top) as usize;
        let mut sum = vec![[0u32; 4]; stride * (rows + 1)];
        let mut sq = vec![0u64; stride * (rows + 1)];
        for yy in 0..rows {
            let (mut row, mut row_sq) = ([0u32; 4], 0u64);
            for x in 0..w as usize {
                let p = src.get_pixel(x as u32, (top as usize + yy) as u32);
                let l = (luma(p) * 255.0) as u32;
                row = [row[0] + p[0] as u32, row[1] + p[1] as u32, row[2] + p[2] as u32, row[3] + l];
                row_sq += (l * l) as u64;
                let above = sum[yy * stride + x + 1];
                sum[(yy + 1) * stride + x + 1] = [above[0] + row[0], above[1] + row[1], above[2] + row[2], above[3] + row[3]];
                sq[(yy + 1) * stride + x + 1] = sq[yy * stride + x + 1] + row_sq;
            }
        }
        let rect = |x0: i32, ya: i32, x1: i32, yb: i32| {
            let (x0, x1) = (x0.clamp(0, wi) as usize, x1.clamp(0, wi) as usize);
            let (ya, yb) = ((ya.clamp(0, hi) - top).max(0) as usize, (yb.clamp(0, hi) - top).min(rows as i32) as usize);
            let n = ((x1 - x0) * (yb - ya)).max(1) as f64;
            let at = |xx: usize, yy: usize| sum[yy * stride + xx];
            let mut c = [0f64; 4];
            for (k, v) in c.iter_mut().enumerate() {
                *v = (at(x1, yb)[k] as f64 - at(x0, yb)[k] as f64 - at(x1, ya)[k] as f64 + at(x0, ya)[k] as f64) / n;
            }
            let s2 = (sq[yb * stride + x1] + sq[ya * stride + x0]) as f64 - (sq[ya * stride + x1] + sq[yb * stride + x0]) as f64;
            ([c[0], c[1], c[2]], s2 / n - c[3] * c[3])
        };
        let mut i = 0;
        for y in y0 as i32..y1 as i32 {
            for x in 0..wi {
                let quads = [
                    rect(x - r, y - r, x + 1, y + 1),
                    rect(x, y - r, x + r + 1, y + 1),
                    rect(x - r, y, x + 1, y + r + 1),
                    rect(x, y, x + r + 1, y + r + 1),
                ];
                let best = quads.iter().min_by(|a, b| a.1.total_cmp(&b.1)).unwrap().0;
                out[i..i + 4].copy_from_slice(&[best[0] as u8, best[1] as u8, best[2] as u8, src.get_pixel(x as u32, y as u32)[3]]);
                i += 4;
            }
        }
    })
}

fn watercolor(src: &RgbaImage, u: f32) -> RgbaImage {
    let (w, h) = src.dimensions();

    // 1. Wobble the edges, as wet paint bleeds: sample through a smooth noise offset.
    let amp = 2.0 * u;
    let wobbled = par_from_fn(w, h, |x, y| {
        let fx = x as f32 / (34.0 * u);
        let fy = y as f32 / (34.0 * u);
        let dx = (fbm(fx, fy, 11, 3) - 0.5) * 2.0 * amp;
        let dy = (fbm(fx + 40.0, fy + 40.0, 12, 3) - 0.5) * 2.0 * amp;
        let sx = (x as f32 + dx).clamp(0.0, (w - 1) as f32) as u32;
        let sy = (y as f32 + dy).clamp(0.0, (h - 1) as f32) as u32;
        *src.get_pixel(sx, sy)
    });

    // 2. Flatten into washes: a painterly filter, then a few soft tonal layers per channel.
    let washed = kuwahara(&wobbled, (3.0 * u).round().max(2.0) as i32);
    let soft = imageops::blur(&washed, 0.7 * u);

    // Fine detail of the drawing underneath (the image minus its blur), laid back over the
    // washes like pen lines in pen-and-wash, so small shapes and edges stay crisp.
    let src_l: Vec<f32> = wobbled.pixels().map(luma).collect();
    let src_blur: Vec<f32> = imageops::blur(&image::GrayImage::from_fn(w, h, |x, y| image::Luma([(src_l[(y * w + x) as usize] * 255.0) as u8])), 1.6 * u)
        .pixels()
        .map(|p| p[0] as f32 / 255.0)
        .collect();

    // 3. Where washes meet, pigment pools into darker, harder edges.
    let l: Vec<f32> = soft.pixels().map(luma).collect();
    let at = |x: i32, y: i32| l[(y.clamp(0, h as i32 - 1) as u32 * w + x.clamp(0, w as i32 - 1) as u32) as usize];
    let edges = image::GrayImage::from_fn(w, h, |x, y| {
        let (x, y) = (x as i32, y as i32);
        let gx = at(x + 1, y - 1) + 2.0 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2.0 * at(x - 1, y) - at(x - 1, y + 1);
        let gy = at(x - 1, y + 1) + 2.0 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2.0 * at(x, y - 1) - at(x + 1, y - 1);
        image::Luma([((gx * gx + gy * gy).sqrt() * 320.0).min(255.0) as u8])
    });
    let edges = imageops::blur(&edges, 0.6 * u);

    // 4. Pigment on paper: transparent washes (lights are paper, darks are never black),
    //    granulation, paper tooth, and an unpainted, deckled border.
    let paper = [0.972f32, 0.955, 0.915];
    let (wf, hf) = (w as f32, h as f32);
    par_from_fn(w, h, |x, y| {
        let p = soft.get_pixel(x, y);
        let e = (edges.get_pixel(x, y)[0] as f32 / 255.0).min(1.0);
        let i = (y * w + x) as usize;
        let detail = src_l[i] - src_blur[i];
        let fx = x as f32 / u;
        let fy = y as f32 / u;
        let mut c = [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0];

        // Tonal layers: snap each channel towards 6 levels, keeping some of the gradient.
        for v in &mut c {
            let q = (*v * 5.0).round() / 5.0;
            *v = *v * 0.6 + q * 0.4;
        }
        // Richer colour, then transparency: mix towards paper by how light it is, and lift the darks.
        let lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        for (k, v) in c.iter_mut().enumerate() {
            let sat = (lum + (*v - lum) * 1.25).clamp(0.0, 1.0);
            let lifted = 0.14 + sat * 0.86;
            *v = lifted + (paper[k] - lifted) * (0.35 * lum.powf(1.2));
        }
        // Pigment density: pooled edges and granulation darken; paper tooth catches it.
        let gran = 0.8 + 0.2 * fbm(fx * 0.45, fy * 0.45, 21, 3);
        let fine = 0.92 + 0.08 * fbm(fx * 2.2, fy * 2.2, 5, 2);
        let pool = 1.0 - 0.55 * e;
        // A slow bloom pattern: lighter blotches with darker rims, as in wet-in-wet.
        let bloom = fbm(fx * 0.02, fy * 0.02, 33, 3);
        let rim = 1.0 - 0.12 * (1.0 - ((bloom - 0.55).abs() * 14.0).min(1.0));
        let lighten = if bloom > 0.55 { 0.08 } else { 0.0 };
        for (k, v) in c.iter_mut().enumerate() {
            let pigment = (1.0 - *v) * gran * fine * rim / pool.max(0.35);
            *v = (1.0 - pigment).clamp(0.0, 1.0);
            *v += (paper[k] - *v) * lighten;
            // Ink: dark detail draws in; light detail lifts the wash, except where pigment pooled.
            *v = (*v + detail * if detail < 0.0 { 0.9 } else { 0.5 * (1.0 - e) }).clamp(0.0, 1.0);
        }
        // Deckled border: the paint stops short of the edge in an irregular line.
        let margin = 0.035 * wf.min(hf);
        let d = (x as f32).min(wf - 1.0 - x as f32).min(y as f32).min(hf - 1.0 - y as f32);
        let ragged = margin * (0.6 + 0.8 * fbm(fx * 0.06 + fy * 0.06, 0.5, 41, 3));
        let paint = ((d - ragged) / (margin * 0.6)).clamp(0.0, 1.0);
        for (k, v) in c.iter_mut().enumerate() {
            *v = paper[k] * fine + (*v - paper[k] * fine) * paint;
        }
        Rgba([(c[0] * 255.0) as u8, (c[1] * 255.0) as u8, (c[2] * 255.0) as u8, p[3]])
    })
}

/// Bumped whenever a style changes, so cached variants drawn by an older version are not reused.
pub const VERSION: u32 = 2;

/// The widest styled art: as wide as 4K art, so a styled hero is never less sharp than the
/// original. Larger originals are scaled down to this first.
pub const MAX_STYLED_WIDTH: u32 = 3840;

/// Resizes (never up) and styles.
pub fn render(img: &DynamicImage, width: Option<u32>, style: ArtStyle, kind: &str) -> RgbaImage {
    let target = width.unwrap_or(img.width()).min(MAX_STYLED_WIDTH);
    let img = if img.width() > target {
        let h = ((img.height() as f64) * (target as f64) / (img.width() as f64)).round().max(1.0) as u32;
        img.resize_exact(target, h, FilterType::Triangle)
    } else {
        img.clone()
    };
    apply(&img, style, kind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbImage;

    fn sample() -> DynamicImage {
        // A bright half and a dark half with a hard edge.
        DynamicImage::ImageRgb8(RgbImage::from_fn(120, 180, |x, _| if x < 60 { image::Rgb([230, 200, 60]) } else { image::Rgb([30, 60, 120]) }))
    }

    #[test]
    fn styles_parse() {
        assert_eq!(ArtStyle::parse("sketch"), Some(ArtStyle::Sketch));
        assert_eq!(ArtStyle::parse("watercolor"), Some(ArtStyle::Watercolor));
        assert_eq!(ArtStyle::parse("oil"), None);
    }

    #[test]
    fn sketch_is_monochrome_with_lines_at_edges() {
        let out = render(&sample(), None, ArtStyle::Sketch, "cover");
        assert_eq!(out.dimensions(), (120, 180));
        for p in out.pixels() {
            let spread = p[0].max(p[1]).max(p[2]) - p[0].min(p[1]).min(p[2]);
            assert!(spread <= 20, "graphite on warm paper only: {p:?}");
        }
        let flat = luma(out.get_pixel(20, 90));
        let edge = (55..65).map(|x| luma(out.get_pixel(x, 90))).fold(1.0f32, f32::min);
        assert!(edge < flat - 0.2, "the hard edge becomes a dark line ({edge} vs {flat})");
    }

    #[test]
    fn watercolor_keeps_colour_and_darkens_edges() {
        let out = render(&sample(), None, ArtStyle::Watercolor, "cover");
        let warm = out.get_pixel(25, 90);
        assert!(warm[0] > warm[2] + 60, "the yellow wash stays yellow: {warm:?}");
        let inside = luma(out.get_pixel(25, 90));
        let edge = (54..60).map(|x| luma(out.get_pixel(x, 90))).fold(1.0f32, f32::min);
        assert!(edge < inside - 0.08, "pigment pools at the edge ({edge} vs {inside})");
    }

    #[test]
    fn styles_are_deterministic_and_capped() {
        let big = DynamicImage::ImageRgb8(RgbImage::from_pixel(4800, 100, image::Rgb([90, 120, 150])));
        let a = render(&big, None, ArtStyle::Watercolor, "hero");
        assert_eq!(a.width(), MAX_STYLED_WIDTH);
        assert_eq!(a, render(&big, None, ArtStyle::Watercolor, "hero"));
    }

    #[test]
    fn styled_heroes_keep_their_resolution() {
        // A 1920 hero is styled at 1920, and thin one-pixel lines survive the watercolor.
        let hero = DynamicImage::ImageRgb8(RgbImage::from_fn(1920, 620, |x, _| if x % 40 == 0 { image::Rgb([10, 10, 10]) } else { image::Rgb([200, 120, 60]) }));
        let out = render(&hero, None, ArtStyle::Watercolor, "hero");
        assert_eq!(out.dimensions(), (1920, 620));
        let line = (798..803).map(|x| luma(out.get_pixel(x, 300))).fold(1.0f32, f32::min);
        let wash = luma(out.get_pixel(820, 300));
        assert!(line < wash - 0.15, "a 1 px line is still drawn ({line} vs {wash})");
    }
}
