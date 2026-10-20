//! Resized art variants: decode, scale to the requested width, encode (JPEG quality 90 for
//! opaque images, PNG for transparent ones) and cache on disk.

use std::borrow::Cow;
use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageFormat, ImageReader};

use super::{short_hash, ArtCandidate, ArtResponse};

pub const WIDTHS: [u32; 5] = [160, 320, 640, 1280, 1920];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    Px(u32),
    /// The original file, byte for byte.
    Full,
}

/// Snaps a requested width up to the next variant; anything above 1920 (or "full") is `Full`.
pub fn snap_width(w: &str) -> Variant {
    match w.parse::<f64>() {
        Ok(px) if px.is_finite() && px > 0.0 => WIDTHS.iter().find(|&&v| v as f64 >= px).map_or(Variant::Full, |&v| Variant::Px(v)),
        Ok(_) => Variant::Px(WIDTHS[0]),
        Err(_) => Variant::Full,
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    }
}

fn has_transparency(img: &DynamicImage) -> bool {
    img.color().has_alpha() && img.to_rgba8().pixels().any(|p| p.0[3] < 255)
}

fn read_original(file: &Path) -> std::io::Result<ArtResponse> {
    Ok(ArtResponse { content_type: content_type(file), body: Cow::Owned(std::fs::read(file)?) })
}

fn cached(path: &Path) -> Option<ArtResponse> {
    let bytes = std::fs::read(path).ok()?;
    let ct = if path.extension().is_some_and(|e| e == "png") { "image/png" } else { "image/jpeg" };
    Some(ArtResponse { content_type: ct, body: Cow::Owned(bytes) })
}

/// Returns the variant of `file` at `width`, from the cache when possible.
pub fn variant(file: &Path, c: &ArtCandidate, width: Variant, cache_dir: &Path) -> std::io::Result<ArtResponse> {
    let Variant::Px(w) = width else { return read_original(file) };
    let key = short_hash((&c.file, c.mtime, c.size));
    let stem = cache_dir.join(format!("{key}-{w}"));
    for ext in ["jpg", "png"] {
        if let Some(r) = cached(&stem.with_extension(ext)) {
            return Ok(r);
        }
    }
    let img = ImageReader::open(file)?
        .with_guessed_format()?
        .decode()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let (ow, oh) = img.dimensions();
    if ow <= w {
        return read_original(file); // never upscale
    }
    let h = ((oh as f64) * (w as f64) / (ow as f64)).round().max(1.0) as u32;
    let small = img.resize_exact(w, h, FilterType::Triangle);
    let mut out = Vec::new();
    let (ext, ct) = if has_transparency(&small) {
        small.write_to(&mut Cursor::new(&mut out), ImageFormat::Png).map_err(std::io::Error::other)?;
        ("png", "image/png")
    } else {
        let rgb = DynamicImage::ImageRgb8(small.to_rgb8());
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
        enc.encode_image(&rgb).map_err(std::io::Error::other)?;
        ("jpg", "image/jpeg")
    };
    if let Err(e) = write_atomic(&stem.with_extension(ext), &out) {
        tracing::warn!(error = %e, "cannot cache art variant");
    }
    Ok(ArtResponse { content_type: ct, body: Cow::Owned(out) })
}

fn write_atomic(path: &PathBuf, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path).or_else(|e| {
        let _ = std::fs::remove_file(&tmp);
        // Another worker may have written the same variant first.
        if path.exists() {
            Ok(())
        } else {
            Err(e)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage, Rgba, RgbaImage};

    #[test]
    fn widths_snap_up() {
        let v: Vec<Variant> = ["1", "160", "161", "640", "1920", "1921", "full", "0", "-5", "abc"].iter().map(|w| snap_width(w)).collect();
        use Variant::*;
        assert_eq!(v, [Px(160), Px(160), Px(320), Px(640), Px(1920), Full, Full, Px(160), Px(160), Full]);
    }

    fn cand(p: &Path) -> ArtCandidate {
        let m = std::fs::metadata(p).unwrap();
        ArtCandidate { kind: "cover".into(), file: Some(p.to_string_lossy().into()), url: None, mtime: Some(1), size: Some(m.len()) }
    }

    #[test]
    fn resizes_caches_and_keeps_alpha() {
        let t = tempfile::tempdir().unwrap();
        let cache = t.path().join("cache");
        let jpg = t.path().join("cover.jpg");
        RgbImage::from_pixel(1200, 1800, Rgb([200, 30, 30])).save(&jpg).unwrap();
        let png = t.path().join("logo.png");
        let mut logo = RgbaImage::from_pixel(800, 200, Rgba([0, 0, 0, 0]));
        logo.put_pixel(10, 10, Rgba([255, 255, 255, 255]));
        logo.save(&png).unwrap();

        let r = variant(&jpg, &cand(&jpg), Variant::Px(320), &cache).unwrap();
        assert_eq!(r.content_type, "image/jpeg");
        let img = image::load_from_memory(&r.body).unwrap();
        assert_eq!(img.dimensions(), (320, 480));
        assert_eq!(std::fs::read_dir(&cache).unwrap().count(), 1, "variant cached");
        let again = variant(&jpg, &cand(&jpg), Variant::Px(320), &cache).unwrap();
        assert_eq!(again.body, r.body);

        let r = variant(&png, &cand(&png), Variant::Px(640), &cache).unwrap();
        assert_eq!(r.content_type, "image/png", "transparent art stays transparent");

        let full = variant(&jpg, &cand(&jpg), Variant::Full, &cache).unwrap();
        assert_eq!(&*full.body, std::fs::read(&jpg).unwrap().as_slice(), "full is the original");
        let not_upscaled = variant(&png, &cand(&png), Variant::Px(1280), &cache).unwrap();
        assert_eq!(&*not_upscaled.body, std::fs::read(&png).unwrap().as_slice());
    }
}
