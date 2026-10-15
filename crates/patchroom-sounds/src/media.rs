//! File types and header-only duration probing for wav, aiff, mp3 and m4a.
//!
//! The probe reads container headers (and, for mp3, walks the frame headers). It never
//! decodes audio, so a hostile file cannot do more than fail the probe.

use crate::{Result, SoundError};

/// Longest custom sound, in milliseconds.
pub const MAX_DURATION_MS: u64 = 5_000;

/// Largest custom sound, in bytes.
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Accepted extensions, for messages.
pub const ACCEPTED: &str = "wav, aiff, mp3, m4a";

/// An accepted audio container.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// RIFF WAVE.
    Wav,
    /// AIFF or AIFF-C.
    Aiff,
    /// MPEG audio layer III.
    Mp3,
    /// MP4 audio.
    M4a,
}

impl Kind {
    /// The kind for a file extension (case-insensitive).
    #[must_use]
    pub fn from_ext(ext: &str) -> Option<Self> {
        match ext.to_ascii_lowercase().as_str() {
            "wav" => Some(Self::Wav),
            "aiff" | "aif" => Some(Self::Aiff),
            "mp3" => Some(Self::Mp3),
            "m4a" => Some(Self::M4a),
            _ => None,
        }
    }

    /// The extension the app stores the file under.
    #[must_use]
    pub fn ext(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Aiff => "aiff",
            Self::Mp3 => "mp3",
            Self::M4a => "m4a",
        }
    }

    /// Media type for a data URL.
    #[must_use]
    pub fn mime(self) -> &'static str {
        match self {
            Self::Wav => "audio/wav",
            Self::Aiff => "audio/aiff",
            Self::Mp3 => "audio/mpeg",
            Self::M4a => "audio/mp4",
        }
    }
}

fn bad(kind: Kind) -> SoundError {
    SoundError::new(format!(
        "That file is not a readable {} sound. Accepted formats: {ACCEPTED}.",
        kind.ext()
    ))
}

fn u16le(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}
fn u32le(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn u16be(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(b.get(at..at + 2)?.try_into().ok()?))
}
fn u32be(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn u64be(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?))
}

/// Duration in milliseconds, read from the header of `data` as the given kind.
///
/// # Errors
/// The bytes are not that container, or the header is damaged.
pub fn duration_ms(kind: Kind, data: &[u8]) -> Result<u64> {
    let ms = match kind {
        Kind::Wav => wav_ms(data),
        Kind::Aiff => aiff_ms(data),
        Kind::Mp3 => mp3_ms(data),
        Kind::M4a => m4a_ms(data),
    }
    .ok_or_else(|| bad(kind))?;
    if ms == 0 {
        return Err(bad(kind));
    }
    Ok(ms)
}

fn wav_ms(b: &[u8]) -> Option<u64> {
    if b.get(0..4)? != b"RIFF" || b.get(8..12)? != b"WAVE" {
        return None;
    }
    let mut pos = 12usize;
    let mut byte_rate = 0u64;
    while pos + 8 <= b.len() {
        let id = b.get(pos..pos + 4)?;
        let size = u64::from(u32le(b, pos + 4)?);
        let body = pos + 8;
        if id == b"fmt " {
            if size < 16 {
                return None;
            }
            let channels = u16le(b, body + 2)?;
            byte_rate = u64::from(u32le(b, body + 8)?);
            if channels == 0 {
                return None;
            }
        } else if id == b"data" {
            if byte_rate == 0 {
                return None;
            }
            let avail = (b.len() - body) as u64;
            let n = size.min(avail);
            return Some(n * 1000 / byte_rate);
        }
        pos = body.checked_add(usize::try_from(size + (size & 1)).ok()?)?;
    }
    None
}

/// 80-bit IEEE extended, as AIFF stores its sample rate.
fn extended_to_f64(b: &[u8]) -> Option<f64> {
    let exp = u16be(b, 0)?;
    let mant = u64be(b, 2)?;
    let e = i32::from(exp & 0x7fff);
    if e == 0 && mant == 0 {
        return Some(0.0);
    }
    if e == 0x7fff {
        return None;
    }
    #[allow(clippy::cast_precision_loss)]
    let m = mant as f64;
    Some(m * 2f64.powi(e - 16383 - 63))
}

fn aiff_ms(b: &[u8]) -> Option<u64> {
    if b.get(0..4)? != b"FORM" || !matches!(b.get(8..12)?, b"AIFF" | b"AIFC") {
        return None;
    }
    let mut pos = 12usize;
    while pos + 8 <= b.len() {
        let id = b.get(pos..pos + 4)?;
        let size = u64::from(u32be(b, pos + 4)?);
        let body = pos + 8;
        if id == b"COMM" {
            if size < 18 {
                return None;
            }
            let channels = u16be(b, body)?;
            let frames = u64::from(u32be(b, body + 2)?);
            let rate = extended_to_f64(b.get(body + 8..body + 18)?)?;
            if channels == 0 || !(1.0..=768_000.0).contains(&rate) {
                return None;
            }
            #[allow(
                clippy::cast_precision_loss,
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss
            )]
            let ms = (frames as f64 * 1000.0 / rate).round() as u64;
            return Some(ms);
        }
        pos = body.checked_add(usize::try_from(size + (size & 1)).ok()?)?;
    }
    None
}

const MP3_BITRATES_V1: [u32; 15] = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MP3_BITRATES_V2: [u32; 15] = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

struct Mp3Frame {
    len: usize,
    samples: u64,
    rate: u64,
    info_tag: bool,
}

fn mp3_frame(b: &[u8], at: usize) -> Option<Mp3Frame> {
    let h = b.get(at..at + 4)?;
    if h[0] != 0xff || h[1] & 0xe0 != 0xe0 {
        return None;
    }
    let version = (h[1] >> 3) & 3; // 0 = 2.5, 2 = v2, 3 = v1
    let layer = (h[1] >> 1) & 3; // 1 = layer III
    if version == 1 || layer != 1 {
        return None;
    }
    let br_idx = usize::from(h[2] >> 4);
    let sr_idx = usize::from((h[2] >> 2) & 3);
    if br_idx == 0 || br_idx == 15 || sr_idx == 3 {
        return None;
    }
    let v1 = version == 3;
    let bitrate = u64::from(if v1 {
        MP3_BITRATES_V1[br_idx]
    } else {
        MP3_BITRATES_V2[br_idx]
    }) * 1000;
    let rate = u64::from(match version {
        3 => [44_100u32, 48_000, 32_000][sr_idx],
        2 => [22_050, 24_000, 16_000][sr_idx],
        _ => [11_025, 12_000, 8_000][sr_idx],
    });
    let pad = u64::from((h[2] >> 1) & 1);
    let coef = if v1 { 144 } else { 72 };
    let len = usize::try_from(coef * bitrate / rate + pad).ok()?;
    if len < 24 {
        return None;
    }
    let mono = (h[3] >> 6) == 3;
    let crc = h[1] & 1 == 0;
    let side = match (v1, mono) {
        (true, false) => 32,
        (true, true) | (false, false) => 17,
        (false, true) => 9,
    };
    let tag_at = at + 4 + side + if crc { 2 } else { 0 };
    let info_tag = matches!(b.get(tag_at..tag_at + 4), Some(b"Xing" | b"Info"));
    Some(Mp3Frame {
        len,
        samples: if v1 { 1152 } else { 576 },
        rate,
        info_tag,
    })
}

fn mp3_ms(b: &[u8]) -> Option<u64> {
    let mut pos = 0usize;
    if b.get(0..3)? == b"ID3" {
        let s = b.get(6..10)?;
        if s.iter().any(|x| x & 0x80 != 0) {
            return None;
        }
        let size = s.iter().fold(0usize, |a, x| (a << 7) | usize::from(*x));
        pos = 10 + size;
    }
    // The first frame must start within 64 KiB of the tags, or it is not an mp3.
    let search_end = pos.saturating_add(64 * 1024).min(b.len());
    let mut first = None;
    let mut p = pos;
    while p + 4 <= search_end {
        if let Some(f) = mp3_frame(b, p) {
            // Confirm with a second frame header right after, to skip false syncs.
            if p + f.len == b.len() || mp3_frame(b, p + f.len).is_some() {
                first = Some(p);
                break;
            }
        }
        p += 1;
    }
    let mut p = first?;
    let (mut samples, mut rate, mut frames) = (0u64, 0u64, 0u32);
    while p + 4 <= b.len() {
        let Some(f) = mp3_frame(b, p) else {
            // A lost sync: look for the next frame, a byte at a time.
            p += 1;
            continue;
        };
        if p + f.len > b.len() {
            break;
        }
        if !(frames == 0 && f.info_tag) {
            samples += f.samples;
            rate = f.rate;
            frames += 1;
        }
        p += f.len;
    }
    if frames == 0 || rate == 0 {
        return None;
    }
    Some(samples * 1000 / rate)
}

/// The payload of the first box called `name` in `data`, and the box count walked.
fn mp4_box<'a>(data: &'a [u8], name: &[u8; 4]) -> Option<&'a [u8]> {
    let mut pos = 0usize;
    while pos + 8 <= data.len() {
        let size32 = u64::from(u32be(data, pos)?);
        let kind = data.get(pos + 4..pos + 8)?;
        let (header, size) = match size32 {
            0 => (8usize, (data.len() - pos) as u64),
            1 => (16usize, u64be(data, pos + 8)?),
            n => (8usize, n),
        };
        if size < header as u64 {
            return None;
        }
        let end = pos.checked_add(usize::try_from(size).ok()?)?;
        let end = end.min(data.len());
        if kind == name {
            return data.get(pos + header..end);
        }
        pos = end;
    }
    None
}

fn m4a_ms(b: &[u8]) -> Option<u64> {
    if b.get(4..8)? != b"ftyp" {
        return None;
    }
    let moov = mp4_box(b, b"moov")?;
    let mvhd = mp4_box(moov, b"mvhd")?;
    let (scale, dur) = match *mvhd.first()? {
        0 => (u64::from(u32be(mvhd, 12)?), u64::from(u32be(mvhd, 16)?)),
        1 => (u64::from(u32be(mvhd, 20)?), u64be(mvhd, 24)?),
        _ => return None,
    };
    if scale == 0 {
        return None;
    }
    Some(dur.saturating_mul(1000) / scale)
}

#[cfg(test)]
pub(crate) mod fixtures {
    //! Synthetic files for tests.

    pub fn wav(ms: u64) -> Vec<u8> {
        let rate = 8000u32;
        let n = (u64::from(rate) * ms / 1000) as u32;
        let mut v = Vec::new();
        v.extend(b"RIFF");
        v.extend((36 + n * 2).to_le_bytes());
        v.extend(b"WAVEfmt ");
        v.extend(16u32.to_le_bytes());
        v.extend(1u16.to_le_bytes());
        v.extend(1u16.to_le_bytes());
        v.extend(rate.to_le_bytes());
        v.extend((rate * 2).to_le_bytes());
        v.extend(2u16.to_le_bytes());
        v.extend(16u16.to_le_bytes());
        v.extend(b"data");
        v.extend((n * 2).to_le_bytes());
        v.extend(std::iter::repeat_n(0u8, (n * 2) as usize));
        v
    }

    pub fn aiff(ms: u64) -> Vec<u8> {
        let rate = 8000u32;
        let frames = (u64::from(rate) * ms / 1000) as u32;
        // 8000 as 80-bit extended: exponent 16383 + 12, mantissa 8000 << 51.
        let mut ext = Vec::new();
        ext.extend((16383u16 + 12).to_be_bytes());
        ext.extend((u64::from(rate) << 51).to_be_bytes());
        let mut comm = Vec::new();
        comm.extend(1u16.to_be_bytes());
        comm.extend(frames.to_be_bytes());
        comm.extend(16u16.to_be_bytes());
        comm.extend(ext);
        let mut v = Vec::new();
        v.extend(b"FORM");
        v.extend((4 + 8 + 18 + 8 + frames * 2).to_be_bytes());
        v.extend(b"AIFFCOMM");
        v.extend(18u32.to_be_bytes());
        v.extend(comm);
        v.extend(b"SSND");
        v.extend((frames * 2).to_be_bytes());
        v.extend(std::iter::repeat_n(0u8, (frames * 2) as usize));
        v
    }

    /// MPEG1 layer III, 128 kbps, 44.1 kHz stereo: 417-byte frames of 26.1 ms.
    pub fn mp3(frames: usize, id3: bool) -> Vec<u8> {
        let mut v = Vec::new();
        if id3 {
            v.extend(b"ID3\x03\x00\x00\x00\x00\x00\x20");
            v.extend(std::iter::repeat_n(0u8, 32));
        }
        for _ in 0..frames {
            let mut f = vec![0u8; 417];
            f[0] = 0xff;
            f[1] = 0xfb;
            f[2] = 0x90;
            f[3] = 0x00;
            v.extend(f);
        }
        v
    }

    fn mp4_box(name: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend((payload.len() as u32 + 8).to_be_bytes());
        v.extend(name);
        v.extend(payload);
        v
    }

    pub fn m4a(ms: u64) -> Vec<u8> {
        let mut mvhd = vec![0u8; 100];
        mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&(ms as u32).to_be_bytes());
        let mut v = mp4_box(b"ftyp", b"M4A \0\0\0\0M4A mp42isom");
        v.extend(mp4_box(b"mdat", &[0u8; 64]));
        v.extend(mp4_box(b"moov", &mp4_box(b"mvhd", &mvhd)));
        v
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn durations_come_from_the_headers() {
        assert_eq!(duration_ms(Kind::Wav, &wav(1500)).unwrap(), 1500);
        assert_eq!(duration_ms(Kind::Aiff, &aiff(2500)).unwrap(), 2500);
        assert_eq!(duration_ms(Kind::M4a, &m4a(3200)).unwrap(), 3200);
        // 10 frames of 1152 samples at 44.1 kHz.
        assert_eq!(duration_ms(Kind::Mp3, &mp3(10, false)).unwrap(), 261);
        assert_eq!(duration_ms(Kind::Mp3, &mp3(10, true)).unwrap(), 261);
    }

    #[test]
    fn a_file_that_is_not_its_extension_is_refused() {
        assert!(duration_ms(Kind::Wav, &mp3(5, false)).is_err());
        assert!(duration_ms(Kind::Mp3, &wav(100)).is_err());
        assert!(duration_ms(Kind::M4a, &wav(100)).is_err());
        assert!(duration_ms(Kind::Aiff, &wav(100)).is_err());
        assert!(duration_ms(Kind::Wav, b"").is_err());
        assert!(duration_ms(Kind::Mp3, b"just some text, not audio at all").is_err());
        assert!(duration_ms(Kind::Wav, &wav(0)).is_err(), "empty audio");
    }

    #[test]
    fn truncated_and_hostile_headers_do_not_panic() {
        for kind in [Kind::Wav, Kind::Aiff, Kind::Mp3, Kind::M4a] {
            let good = match kind {
                Kind::Wav => wav(500),
                Kind::Aiff => aiff(500),
                Kind::Mp3 => mp3(20, true),
                Kind::M4a => m4a(500),
            };
            for n in 0..good.len().min(120) {
                let _ = duration_ms(kind, &good[..n]);
            }
            let _ = duration_ms(kind, &vec![0xffu8; 4096]);
        }
        // A data chunk that claims more than the file holds is clamped to the file.
        let mut w = wav(100);
        w[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(duration_ms(Kind::Wav, &w).unwrap() <= 100);
    }

    #[test]
    fn extensions_map_to_kinds() {
        assert_eq!(Kind::from_ext("WAV"), Some(Kind::Wav));
        assert_eq!(Kind::from_ext("aiff"), Some(Kind::Aiff));
        assert_eq!(Kind::from_ext("ogg"), None);
        assert_eq!(Kind::from_ext("flac"), None);
        assert_eq!(Kind::M4a.mime(), "audio/mp4");
    }
}
