use std::path::{Path, PathBuf};

fn main() {
    embed_sdk();
    tauri_build::build()
}

/// Copies the built skin SDK (`sdk/dist/sdk.js`) into OUT_DIR so it can be embedded in the
/// exe. Without a build, a stub is embedded that tells the skin author what to run.
fn embed_sdk() {
    let src = Path::new("../sdk/dist/sdk.js");
    println!("cargo:rerun-if-changed=../sdk/dist/sdk.js");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("sdk.js");
    let bytes = std::fs::read(src).unwrap_or_else(|_| {
        println!("cargo:warning=sdk/dist/sdk.js not found; embedding a stub. Run `npm run build:sdk`.");
        b"throw new Error('The Vellum SDK was not built: run npm run build:sdk');".to_vec()
    });
    std::fs::write(out, bytes).unwrap();
}
