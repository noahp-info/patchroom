//! Loudness measurement for imported sounds.
//!
//! A file is decoded in memory (pure Rust, no network, nothing written) and measured for its
//! mean level (RMS over every sample of every channel, the same figure ffmpeg's `volumedetect`
//! calls `mean_volume`) and its sample peak. The normalizing gain brings the mean to
//! [`TARGET_MEAN_DB`] without pushing the peak above [`PEAK_CAP_DB`]. The gain is stored next to
//! the file; the file itself is never changed.

use std::io::Cursor;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Mean level every sound is brought to, in dBFS.
pub const TARGET_MEAN_DB: f64 = -22.0;

/// Highest peak a normalized sound may reach, in dBFS.
pub const PEAK_CAP_DB: f64 = -3.0;

/// Smallest and largest normalizing gain stored.
pub const NORM_RANGE: (f64, f64) = (0.05, 8.0);

/// Most samples decoded (a 5 s stereo file at 48 kHz is 480 000), so a hostile file stays cheap.
const MAX_SAMPLES: u64 = 4_000_000;

/// What was measured.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Loudness {
    /// Mean (RMS) level in dBFS.
    pub mean_db: f64,
    /// Sample peak in dBFS.
    pub peak_db: f64,
}

fn db(x: f64) -> f64 {
    20.0 * x.log10()
}

/// Decode `bytes` (`ext` is a hint such as `"wav"`) and measure it. `None` when the file
/// cannot be decoded or is silent.
#[must_use]
pub fn measure(bytes: &[u8], ext: &str) -> Option<Loudness> {
    let mss = MediaSourceStream::new(Box::new(Cursor::new(bytes.to_vec())), Default::default());
    let mut hint = Hint::new();
    hint.with_extension(ext);
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .ok()?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .ok()?;
    let (mut sum_sq, mut n, mut peak) = (0.0f64, 0u64, 0.0f64);
    let mut buf: Option<SampleBuffer<f32>> = None;
    while n < MAX_SAMPLES {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(_) | SymError::ResetRequired) => break,
            Err(_) => return None,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue,
            Err(_) => break,
        };
        let b = buf.get_or_insert_with(|| {
            SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec())
        });
        if (decoded.capacity() as u64) > b.capacity() as u64 {
            *b = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
        }
        b.copy_interleaved_ref(decoded);
        for s in b.samples() {
            let v = f64::from(*s);
            sum_sq += v * v;
            peak = peak.max(v.abs());
            n += 1;
        }
    }
    if n == 0 || peak <= 1e-6 || sum_sq <= 0.0 {
        return None;
    }
    #[allow(clippy::cast_precision_loss)]
    let rms = (sum_sq / n as f64).sqrt();
    Some(Loudness {
        mean_db: db(rms),
        peak_db: db(peak),
    })
}

/// The gain that brings `l` to the target mean without the peak passing the cap.
#[must_use]
pub fn norm_gain(l: Loudness) -> f64 {
    let to_target = TARGET_MEAN_DB - l.mean_db;
    let to_cap = PEAK_CAP_DB - l.peak_db;
    let g = 10f64.powf(to_target.min(to_cap) / 20.0);
    let g = g.clamp(NORM_RANGE.0, NORM_RANGE.1);
    (g * 1000.0).round() / 1000.0
}

/// Measure `bytes` and return the normalizing gain; 1 when it cannot be measured.
#[must_use]
pub fn norm_for(bytes: &[u8], ext: &str) -> f64 {
    measure(bytes, ext).map_or(1.0, norm_gain)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A mono 16-bit 44.1 kHz wav of a sine at `amp` (0 to 1), `ms` long.
    pub fn sine_wav(amp: f64, ms: u32) -> Vec<u8> {
        let rate = 44_100u32;
        let n = rate * ms / 1000;
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
        for i in 0..n {
            let x = (f64::from(i) * 2.0 * std::f64::consts::PI * 440.0 / f64::from(rate)).sin();
            #[allow(clippy::cast_possible_truncation)]
            let s = (x * amp * 32767.0).round() as i16;
            v.extend(s.to_le_bytes());
        }
        v
    }

    #[test]
    fn a_sine_measures_as_its_known_level() {
        // Amplitude 0.5: peak -6.02 dBFS, RMS -9.03 dBFS.
        let l = measure(&sine_wav(0.5, 500), "wav").unwrap();
        assert!((l.peak_db + 6.02).abs() < 0.1, "{l:?}");
        assert!((l.mean_db + 9.03).abs() < 0.1, "{l:?}");
    }

    #[test]
    fn a_loud_sound_is_turned_down_and_a_quiet_one_up() {
        let loud = norm_gain(measure(&sine_wav(0.9, 400), "wav").unwrap());
        assert!(loud < 0.3, "{loud}");
        let quiet = norm_gain(measure(&sine_wav(0.01, 400), "wav").unwrap());
        assert!(quiet > 1.5, "{quiet}");
    }

    #[test]
    fn normalized_output_hits_the_target_and_respects_the_peak_cap() {
        for amp in [0.9, 0.3, 0.05, 0.02] {
            let l = measure(&sine_wav(amp, 400), "wav").unwrap();
            let g = norm_gain(l);
            let (mean, peak) = (l.mean_db + db(g), l.peak_db + db(g));
            assert!(peak <= PEAK_CAP_DB + 0.05, "amp {amp}: peak {peak}");
            // A sine's peak is 3 dB over its mean, so -22 mean is under the cap: exact.
            assert!(
                (mean - TARGET_MEAN_DB).abs() < 0.1,
                "amp {amp}: mean {mean}"
            );
        }
    }

    #[test]
    fn a_peaky_sound_is_held_by_the_peak_cap_not_the_target() {
        let l = Loudness {
            mean_db: -30.0,
            peak_db: -4.0,
        };
        let g = norm_gain(l);
        assert!((l.peak_db + db(g) - PEAK_CAP_DB).abs() < 0.01);
        assert!(l.mean_db + db(g) < TARGET_MEAN_DB);
    }

    #[test]
    fn silence_and_garbage_are_unmeasurable_and_get_a_gain_of_one() {
        assert!(measure(&crate::media::fixtures::wav(300), "wav").is_none());
        assert!(measure(b"not audio at all, just text", "wav").is_none());
        assert!(measure(&[], "mp3").is_none());
        assert!((norm_for(b"junk", "m4a") - 1.0).abs() < f64::EPSILON);
        assert!((norm_for(&crate::media::fixtures::wav(300), "wav") - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn a_truncated_file_does_not_panic() {
        let w = sine_wav(0.4, 300);
        for n in [0, 10, 44, 100, 2000] {
            let _ = measure(&w[..n.min(w.len())], "wav");
        }
    }
}
