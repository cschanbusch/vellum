//! Embeds the app icon so Explorer, shortcuts and the taskbar show it on the starter too.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rerun-if-changed=../src-tauri/icons/icon.ico");
        embed_resource::compile("starter.rc", embed_resource::NONE)
            .manifest_optional()
            .unwrap();
    }
}
