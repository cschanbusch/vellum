//! A tiny HTTP server for tests: fixed routes by path (the query is ignored).

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;

/// Serves `routes` (path, status, body) on a free local port and returns `http://127.0.0.1:<port>`.
pub fn serve(routes: Vec<(&'static str, u16, Vec<u8>)>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                continue;
            }
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).map_or(true, |n| n == 0) || h == "\r\n" {
                    break;
                }
            }
            let path = line.split_whitespace().nth(1).unwrap_or("/").split('?').next().unwrap_or("/").to_string();
            let (status, body) = routes.iter().find(|(p, _, _)| *p == path).map_or((404, b"missing".to_vec()), |(_, s, b)| (*s, b.clone()));
            let mut s = stream;
            let _ = write!(s, "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = s.write_all(&body);
        }
    });
    format!("http://{addr}")
}

pub fn png_bytes(w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::new();
    image::RgbImage::from_pixel(w, h, image::Rgb([10, 20, 30]))
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}
