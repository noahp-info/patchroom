//! Dictation for the chat composer, on-device only.
//!
//! Speech never leaves the Mac. A small Swift helper (`helper/PatchroomDictation.swift`, built
//! into the app bundle as `patchroom-dictation`) captures audio with AVAudioEngine and runs
//! `SFSpeechRecognizer` with `requiresOnDeviceRecognition`. It streams transcripts as JSON
//! lines on stdout ([`protocol`]). The app spawns it only while dictating and kills it on stop
//! or quit ([`process`]). The helper keeps Apple's frameworks out of the Rust process, so
//! `unsafe_code` stays forbidden.
//!
//! The helper must not start child processes: the app kills it by pid.

pub mod process;
pub mod protocol;

pub use process::{query, EndReason, Options, Output, Session};
pub use protocol::{
    dictate_args, list_args, parse_line, settings_url, valid_locale, ErrorCode, HelperEvent,
    LocaleInfo, Permission,
};
