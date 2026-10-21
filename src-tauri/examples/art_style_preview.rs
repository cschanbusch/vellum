//! Renders an image in every art style, for tuning the styles by eye.
//!
//!   cargo run --release --example art_style_preview -- <image> [width] [out dir] [kind]
//!
//! Writes <name>-sketch.png and <name>-watercolor.png beside the input (or into out dir).

use std::path::PathBuf;
use std::time::Instant;

use vellum_lib::art::style::{render, ArtStyle};

fn main() {
    let mut args = std::env::args().skip(1);
    let input = PathBuf::from(args.next().expect("usage: art_style_preview <image> [width] [out dir]"));
    let width: Option<u32> = args.next().and_then(|w| w.parse().ok());
    let out_dir = args.next().map(PathBuf::from).unwrap_or_else(|| input.parent().unwrap().to_path_buf());
    let kind = args.next().unwrap_or_else(|| "cover".to_string());
    let img = image::open(&input).expect("cannot read the image");
    let stem = input.file_stem().unwrap().to_string_lossy().into_owned();
    for style in [ArtStyle::Sketch, ArtStyle::Watercolor] {
        let t = Instant::now();
        let out = render(&img, width, style, &kind);
        let path = out_dir.join(format!("{stem}-{}.png", style.name()));
        out.save(&path).unwrap();
        println!("{} {}x{} in {} ms -> {}", style.name(), out.width(), out.height(), t.elapsed().as_millis(), path.display());
    }
}
