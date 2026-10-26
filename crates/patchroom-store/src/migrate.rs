//! Embedded, forward-only migration runner keyed on `PRAGMA user_version`.

use rusqlite::Connection;

use crate::error::{Error, Result};

/// One migration step. `version` values are 1, 2, 3, ... with no gaps.
struct Migration {
    version: u32,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        sql: include_str!("../migrations/0001_init.sql"),
    },
    Migration {
        version: 2,
        sql: include_str!("../migrations/0002_badges.sql"),
    },
    Migration {
        version: 3,
        sql: include_str!("../migrations/0003_slack.sql"),
    },
    Migration {
        version: 4,
        sql: include_str!("../migrations/0004_folder_sections.sql"),
    },
    Migration {
        version: 5,
        sql: include_str!("../migrations/0005_section_kind.sql"),
    },
    Migration {
        version: 6,
        sql: include_str!("../migrations/0006_emoji_flavor.sql"),
    },
];

/// Highest schema version this build understands.
pub const LATEST_VERSION: u32 = MIGRATIONS[MIGRATIONS.len() - 1].version;

/// Current `user_version` of the connection.
pub fn current_version(conn: &Connection) -> Result<u32> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get(0))?)
}

/// Apply every pending migration, each in its own transaction.
pub fn run(conn: &mut Connection) -> Result<()> {
    let found = current_version(conn)?;
    if found > LATEST_VERSION {
        return Err(Error::SchemaTooNew {
            found,
            supported: LATEST_VERSION,
        });
    }
    for m in MIGRATIONS.iter().filter(|m| m.version > found) {
        let tx = conn.transaction()?;
        tx.execute_batch(m.sql)?;
        tx.pragma_update(None, "user_version", m.version)?;
        tx.commit()?;
    }
    Ok(())
}

/// The raw SQL of every migration, for audits such as the no-secrets test.
pub fn all_sql() -> impl Iterator<Item = &'static str> {
    MIGRATIONS.iter().map(|m| m.sql)
}
