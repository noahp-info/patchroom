//! Do Not Disturb: a manual switch plus a weekly schedule in local wall-clock time.
//!
//! The schedule has days (0 is Sunday, as in JavaScript), a start and an end ("HH:MM"). When
//! the end is earlier than the start the window crosses midnight, and its days name the day
//! it starts on: Friday 22:00 to 07:00 covers Friday night and Saturday morning. Start equal
//! to end is an empty window.
//!
//! The math takes a local `NaiveDateTime`, so a daylight-saving change needs no special case:
//! the caller converts the instant to local wall time first, and the window is compared on the
//! wall clock. The repeated hour of a fall-back and the skipped hour of a spring-forward both
//! stay inside or outside the window exactly as the clock on the wall says.

use chrono::{Datelike, NaiveDateTime, Timelike};
use serde::{Deserialize, Serialize};

/// A weekly quiet window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Schedule {
    /// Days the window starts on, 0 (Sunday) to 6 (Saturday).
    pub days: Vec<u8>,
    /// "HH:MM", 24-hour, local.
    pub start: String,
    /// "HH:MM", 24-hour, local.
    pub end: String,
}

/// Do Not Disturb settings.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Dnd {
    /// On until switched off.
    pub manual: bool,
    /// The weekly window, if any.
    pub schedule: Option<Schedule>,
}

/// "HH:MM" to minutes since midnight. `None` unless it is a valid 24-hour time.
#[must_use]
pub fn parse_hhmm(s: &str) -> Option<u32> {
    let (h, m) = s.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

impl Schedule {
    /// Is local wall time `at` inside the window? A schedule with a bad time is never active.
    #[must_use]
    pub fn contains(&self, at: NaiveDateTime) -> bool {
        let (Some(start), Some(end)) = (parse_hhmm(&self.start), parse_hhmm(&self.end)) else {
            return false;
        };
        let day = at.weekday().num_days_from_sunday() as u8;
        let prev = (day + 6) % 7;
        let on = |d: u8| self.days.contains(&d);
        let m = at.hour() * 60 + at.minute();
        match start.cmp(&end) {
            std::cmp::Ordering::Equal => false,
            std::cmp::Ordering::Less => on(day) && (start..end).contains(&m),
            std::cmp::Ordering::Greater => (on(day) && m >= start) || (on(prev) && m < end),
        }
    }
}

impl Dnd {
    /// Is Do Not Disturb on at local wall time `at`?
    #[must_use]
    pub fn active_at(&self, at: NaiveDateTime) -> bool {
        self.manual || self.schedule.as_ref().is_some_and(|s| s.contains(at))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{NaiveDate, TimeZone, Utc};
    use chrono_tz::America::New_York;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, mo, d)
            .unwrap()
            .and_hms_opt(h, mi, 0)
            .unwrap()
    }

    fn sched(days: &[u8], start: &str, end: &str) -> Schedule {
        Schedule {
            days: days.to_vec(),
            start: start.into(),
            end: end.into(),
        }
    }

    /// 2026-10-12 is a Monday (day 1).
    #[test]
    fn same_day_window_is_half_open() {
        let s = sched(&[1], "09:00", "17:00");
        assert!(!s.contains(at(2026, 10, 12, 8, 59)));
        assert!(s.contains(at(2026, 10, 12, 9, 0)));
        assert!(s.contains(at(2026, 10, 12, 16, 59)));
        assert!(!s.contains(at(2026, 10, 12, 17, 0)));
        // Tuesday is not a listed day.
        assert!(!s.contains(at(2026, 10, 13, 10, 0)));
    }

    #[test]
    fn window_crossing_midnight_belongs_to_the_day_it_starts_on() {
        // Monday 22:00 to Tuesday 07:00.
        let s = sched(&[1], "22:00", "07:00");
        assert!(!s.contains(at(2026, 10, 12, 21, 59)));
        assert!(s.contains(at(2026, 10, 12, 22, 0)));
        assert!(s.contains(at(2026, 10, 12, 23, 59)));
        assert!(s.contains(at(2026, 10, 13, 0, 0)));
        assert!(s.contains(at(2026, 10, 13, 6, 59)));
        assert!(!s.contains(at(2026, 10, 13, 7, 0)));
        // Monday morning belongs to Sunday's window, which is not listed.
        assert!(!s.contains(at(2026, 10, 12, 3, 0)));
        // Tuesday night is not listed.
        assert!(!s.contains(at(2026, 10, 13, 23, 0)));
    }

    #[test]
    fn midnight_crossing_wraps_the_week() {
        // Saturday 23:00 to Sunday 06:00 (days 6 -> 0).
        let s = sched(&[6], "23:00", "06:00");
        assert!(s.contains(at(2026, 10, 17, 23, 30))); // Saturday
        assert!(s.contains(at(2026, 10, 18, 5, 59))); // Sunday
        assert!(!s.contains(at(2026, 10, 18, 6, 0)));
        // Sunday's window would start Sunday 23:00; it is not listed.
        assert!(!s.contains(at(2026, 10, 18, 23, 30)));
    }

    #[test]
    fn empty_equal_and_bad_schedules_are_never_active() {
        assert!(!sched(&[], "22:00", "07:00").contains(at(2026, 10, 12, 23, 0)));
        assert!(!sched(&[1], "10:00", "10:00").contains(at(2026, 10, 12, 10, 0)));
        assert!(!sched(&[1], "24:00", "07:00").contains(at(2026, 10, 12, 23, 0)));
        assert!(!sched(&[1], "9:00", "17:00").contains(at(2026, 10, 12, 10, 0)));
        assert_eq!(parse_hhmm("00:00"), Some(0));
        assert_eq!(parse_hhmm("23:59"), Some(1439));
        assert_eq!(parse_hhmm("12:60"), None);
        assert_eq!(parse_hhmm("noon"), None);
    }

    #[test]
    fn manual_overrides_the_schedule() {
        let d = Dnd {
            manual: true,
            schedule: None,
        };
        assert!(d.active_at(at(2026, 10, 12, 12, 0)));
        let d = Dnd {
            manual: false,
            schedule: Some(sched(&[1], "22:00", "07:00")),
        };
        assert!(!d.active_at(at(2026, 10, 12, 12, 0)));
        assert!(d.active_at(at(2026, 10, 12, 23, 0)));
    }

    /// Wall-clock time of a UTC instant in New York.
    fn ny(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> NaiveDateTime {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0)
            .unwrap()
            .with_timezone(&New_York)
            .naive_local()
    }

    #[test]
    fn spring_forward_night_keeps_the_window_on_the_wall_clock() {
        // US DST starts Sunday 2026-03-08: 02:00 EST jumps to 03:00 EDT.
        // Saturday 22:00 to Sunday 07:00 (days 6 -> 0).
        let s = sched(&[6], "22:00", "07:00");
        // 06:59 UTC = 01:59 EST: inside.
        assert!(s.contains(ny(2026, 3, 8, 6, 59)));
        // 07:00 UTC = 03:00 EDT: the skipped hour is gone, still inside.
        assert!(s.contains(ny(2026, 3, 8, 7, 0)));
        // 10:59 UTC = 06:59 EDT: inside. 11:00 UTC = 07:00 EDT: out.
        assert!(s.contains(ny(2026, 3, 8, 10, 59)));
        assert!(!s.contains(ny(2026, 3, 8, 11, 0)));
        // A window that starts inside the skipped hour starts at 03:00 wall time.
        let s = sched(&[0], "02:30", "04:00");
        assert!(!s.contains(ny(2026, 3, 8, 6, 59))); // 01:59 EST
        assert!(s.contains(ny(2026, 3, 8, 7, 0))); // 03:00 EDT
        assert!(!s.contains(ny(2026, 3, 8, 8, 0))); // 04:00 EDT
    }

    #[test]
    fn fall_back_night_counts_the_repeated_hour_twice() {
        // US DST ends Sunday 2026-11-01: 02:00 EDT falls back to 01:00 EST.
        let s = sched(&[6], "22:00", "07:00");
        // 05:30 UTC = 01:30 EDT (first pass) and 06:30 UTC = 01:30 EST (second pass).
        assert!(s.contains(ny(2026, 11, 1, 5, 30)));
        assert!(s.contains(ny(2026, 11, 1, 6, 30)));
        assert_eq!(ny(2026, 11, 1, 5, 30).time(), ny(2026, 11, 1, 6, 30).time());
        // 11:59 UTC = 06:59 EST: inside; 12:00 UTC = 07:00 EST: out.
        assert!(s.contains(ny(2026, 11, 1, 11, 59)));
        assert!(!s.contains(ny(2026, 11, 1, 12, 0)));
        // A window ending inside the repeated hour ends the first time the clock reads it.
        let s = sched(&[0], "00:30", "01:30");
        assert!(s.contains(ny(2026, 11, 1, 5, 0))); // 01:00 EDT
        assert!(!s.contains(ny(2026, 11, 1, 5, 30))); // 01:30 EDT
        assert!(s.contains(ny(2026, 11, 1, 6, 0))); // 01:00 EST: inside again
        assert!(!s.contains(ny(2026, 11, 1, 6, 30))); // 01:30 EST
    }
}
