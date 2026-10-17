//! Window capture: Patchroom's own window pixels, for screenshot-to-steer and the frozen viewer.
//!
//! macOS lets an app read its own windows without the Screen Recording permission, so this
//! captures exactly one window (ours, by window number) and never the screen. No entitlement,
//! no permission prompt, no other app's pixels.
//!
//! Flow: [`window_rgba`] grabs the whole window once as RGBA in device pixels. [`Frame::crop`]
//! cuts a CSS-pixel rectangle out of it and [`encode_png`] writes the PNG.

use crate::viewer::Rect;

/// One captured window, RGBA, row-major, with the CSS-to-device scale.
#[derive(Debug, Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    /// Device pixels per CSS pixel (2.0 on Retina).
    pub scale: f64,
    pub rgba: Vec<u8>,
}

impl Frame {
    /// The part of the frame under `r` (CSS pixels), clamped to the frame. `None` when empty.
    #[must_use]
    pub fn crop(&self, r: Rect) -> Option<Frame> {
        let s = self.scale;
        let px = |v: f64, max: u32| -> u32 {
            let v = (v * s).round();
            if v <= 0.0 {
                0
            } else if v >= f64::from(max) {
                max
            } else {
                // In range by the checks above.
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let n = v as u32;
                n
            }
        };
        let x0 = px(r.x, self.width);
        let y0 = px(r.y, self.height);
        let x1 = px(r.x + r.width, self.width);
        let y1 = px(r.y + r.height, self.height);
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        let (w, h) = (x1 - x0, y1 - y0);
        let stride = self.width as usize * 4;
        let mut out = Vec::with_capacity(w as usize * h as usize * 4);
        for y in y0..y1 {
            let start = y as usize * stride + x0 as usize * 4;
            out.extend_from_slice(&self.rgba[start..start + w as usize * 4]);
        }
        Some(Frame {
            width: w,
            height: h,
            scale: s,
            rgba: out,
        })
    }
}

/// Encode a frame as PNG. Fast compression: a capture must reach the composer in well under 2 s.
///
/// # Errors
/// The encoder failed (it does not for a well-formed frame).
pub fn encode_png(f: &Frame) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, f.width, f.height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut w = enc.write_header().map_err(|e| e.to_string())?;
        w.write_image_data(&f.rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Convert premultiplied BGRA rows (CoreGraphics' native window format) to straight RGBA.
#[must_use]
pub fn bgra_to_rgba(src: &[u8], width: usize, height: usize, stride: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        let row = &src[y * stride..y * stride + width * 4];
        for px in row.chunks_exact(4) {
            let (b, g, r, a) = (px[0], px[1], px[2], px[3]);
            let un = |c: u8| -> u8 {
                if a == 0 || a == 255 {
                    c
                } else {
                    let v = (u32::from(c) * 255 + u32::from(a) / 2) / u32::from(a);
                    u8::try_from(v.min(255)).unwrap_or(255)
                }
            };
            out.extend_from_slice(&[un(r), un(g), un(b), a]);
        }
    }
    out
}

/// Capture Patchroom's main window. Must not be called on the main thread: it waits for the
/// main thread to name the window.
///
/// # Errors
/// No window, or the system returned no image.
#[cfg(target_os = "macos")]
pub fn window_rgba(app: &tauri::AppHandle) -> Result<Frame, String> {
    use core_graphics::geometry::{CGPoint, CGRect, CGSize};
    use core_graphics::window::{
        create_image, kCGWindowImageBestResolution, kCGWindowImageBoundsIgnoreFraming,
        kCGWindowListOptionIncludingWindow,
    };
    use tauri::Manager;

    let win = app.get_window("main").ok_or("no main window")?;
    // Device pixels per CSS pixel. The image can be smaller than the window (a window larger
    // than its screen is cut at the screen edge), so the scale never comes from its width.
    let device_scale = win.scale_factor().map_err(|e| e.to_string())?;
    let number = main_window_number(app)?;
    let id = u32::try_from(number).map_err(|_| "bad window number".to_owned())?;
    // CGRectNull: the window's own bounds.
    let null = CGRect::new(
        &CGPoint::new(f64::INFINITY, f64::INFINITY),
        &CGSize::new(0.0, 0.0),
    );
    let img = create_image(
        null,
        kCGWindowListOptionIncludingWindow,
        id,
        kCGWindowImageBoundsIgnoreFraming | kCGWindowImageBestResolution,
    )
    .ok_or("the system returned no image of the window")?;
    if img.bits_per_pixel() != 32 || img.bits_per_component() != 8 {
        return Err(format!(
            "unexpected pixel format ({} bits per pixel)",
            img.bits_per_pixel()
        ));
    }
    let (w, h, stride) = (img.width(), img.height(), img.bytes_per_row());
    let data = img.data();
    let bytes = data.bytes();
    if bytes.len() < stride * h || w == 0 || h == 0 {
        return Err("the window image is empty".into());
    }
    let rgba = bgra_to_rgba(bytes, w, h, stride);
    let scale = if device_scale > 0.0 {
        device_scale
    } else {
        1.0
    };
    Ok(Frame {
        width: u32::try_from(w).map_err(|e| e.to_string())?,
        height: u32::try_from(h).map_err(|e| e.to_string())?,
        scale,
        rgba,
    })
}

/// The main window's number, read on the main thread through AppKit.
#[cfg(target_os = "macos")]
fn main_window_number(app: &tauri::AppHandle) -> Result<isize, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let n = MainThreadMarker::new().and_then(|mtm| {
            let ns = NSApplication::sharedApplication(mtm);
            // Main or key when Patchroom is in front; otherwise (launched in the background,
            // another app active) the largest visible window Patchroom owns.
            ns.mainWindow()
                .or_else(|| ns.keyWindow())
                .map(|w| w.windowNumber())
                .or_else(|| {
                    ns.windows()
                        .iter()
                        .filter(|w| w.isVisible() && w.windowNumber() > 0)
                        .max_by(|a, b| {
                            let area = |w: &objc2_app_kit::NSWindow| {
                                let f = w.frame();
                                f.size.width * f.size.height
                            };
                            area(a).total_cmp(&area(b))
                        })
                        .map(|w| w.windowNumber())
                })
        });
        let _ = tx.send(n);
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(2))
        .map_err(|_| "the main thread did not answer".to_owned())?
        .filter(|n| *n > 0)
        .ok_or_else(|| "no Patchroom window is open".to_owned())
}

/// Other platforms: not built yet.
///
/// # Errors
/// Always.
#[cfg(not(target_os = "macos"))]
pub fn window_rgba(_app: &tauri::AppHandle) -> Result<Frame, String> {
    Err("window capture is macOS only for now".into())
}

/// `data:image/png;base64,...` for a PNG.
#[must_use]
pub fn data_url(png: &[u8]) -> String {
    use base64::Engine;
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(w: u32, h: u32, scale: f64) -> Frame {
        let mut rgba = Vec::new();
        for y in 0..h {
            for x in 0..w {
                rgba.extend_from_slice(&[
                    u8::try_from(x).unwrap(),
                    u8::try_from(y).unwrap(),
                    0,
                    255,
                ]);
            }
        }
        Frame {
            width: w,
            height: h,
            scale,
            rgba,
        }
    }

    #[test]
    fn crop_scales_css_pixels_to_device_pixels() {
        let f = frame(40, 20, 2.0);
        let c = f
            .crop(Rect {
                x: 5.0,
                y: 2.0,
                width: 4.0,
                height: 3.0,
            })
            .unwrap();
        assert_eq!((c.width, c.height), (8, 6));
        // First pixel is device (10, 4).
        assert_eq!(&c.rgba[..4], &[10, 4, 0, 255]);
    }

    #[test]
    fn crop_clamps_to_the_frame_and_refuses_empty_boxes() {
        let f = frame(10, 10, 1.0);
        let c = f
            .crop(Rect {
                x: -5.0,
                y: 8.0,
                width: 100.0,
                height: 100.0,
            })
            .unwrap();
        assert_eq!((c.width, c.height), (10, 2));
        assert!(f
            .crop(Rect {
                x: 3.0,
                y: 3.0,
                width: 0.0,
                height: 4.0
            })
            .is_none());
        assert!(f
            .crop(Rect {
                x: 20.0,
                y: 0.0,
                width: 5.0,
                height: 5.0
            })
            .is_none());
    }

    #[test]
    fn bgra_becomes_straight_rgba() {
        // One opaque blue pixel, one half-transparent premultiplied red pixel, 4 bytes padding.
        let src = [255, 0, 0, 255, 0, 0, 64, 128, 9, 9, 9, 9];
        let out = bgra_to_rgba(&src, 2, 1, 12);
        assert_eq!(out, vec![0, 0, 255, 255, 128, 0, 0, 128]);
    }

    #[test]
    fn png_round_trips_its_size() {
        let png = encode_png(&frame(7, 3, 1.0)).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let dec = png::Decoder::new(std::io::Cursor::new(png));
        let r = dec.read_info().unwrap();
        assert_eq!((r.info().width, r.info().height), (7, 3));
        assert!(data_url(b"x").starts_with("data:image/png;base64,"));
    }
}
