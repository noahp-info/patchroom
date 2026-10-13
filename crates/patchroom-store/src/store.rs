//! Connection handling and shared row helpers.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::types::Type;
use rusqlite::{Connection, Row};
use ulid::Generator;

use crate::error::Result;
use crate::migrate;
use crate::types::{Author, Id, Millis};

/// File name of the database inside the data directory.
pub const DB_FILE: &str = "patchroom.db";

/// Handle to the Patchroom database. One handle per thread; open another for more.
#[derive(Debug)]
pub struct Store {
    pub(crate) conn: Connection,
    path: Option<PathBuf>,
}

impl Store {
    /// Open (creating if needed) `<data_dir>/patchroom.db`, enable WAL and
    /// foreign keys, and apply pending migrations. The caller owns the path;
    /// the store writes nowhere else.
    pub fn open(data_dir: impl AsRef<Path>) -> Result<Self> {
        let dir = data_dir.as_ref();
        std::fs::create_dir_all(dir)?;
        let path = dir.join(DB_FILE);
        let conn = Connection::open(&path)?;
        Self::init(conn, Some(path))
    }

    /// Open a private in-memory database (tests, previews). No WAL.
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?, None)
    }

    fn init(mut conn: Connection, path: Option<PathBuf>) -> Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "foreign_keys", true)?;
        if path.is_some() {
            let mode: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
            debug_assert_eq!(mode.to_lowercase(), "wal");
            conn.pragma_update(None, "synchronous", "NORMAL")?;
        }
        migrate::run(&mut conn)?;
        Ok(Store { conn, path })
    }

    /// Location of the database file, or `None` for in-memory stores.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// Current schema version.
    pub fn schema_version(&self) -> Result<u32> {
        migrate::current_version(&self.conn)
    }

    /// The journal mode in effect (`wal` for file databases).
    pub fn journal_mode(&self) -> Result<String> {
        Ok(self
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))?)
    }

    /// Whether foreign key enforcement is on.
    pub fn foreign_keys_enabled(&self) -> Result<bool> {
        Ok(self
            .conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get::<_, i64>(0))?
            == 1)
    }
}

pub(crate) fn now() -> Millis {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as Millis)
        .unwrap_or(0)
}

static IDS: Mutex<Generator> = Mutex::new(Generator::new());

/// Mint a ULID. Ids from one process are strictly increasing.
pub(crate) fn new_id() -> Id {
    let mut g = IDS.lock().unwrap_or_else(|p| p.into_inner());
    match g.generate() {
        Ok(id) => id,
        Err(overflow) => overflow.commit_overflow_random(),
    }
}

fn conv_err<E>(idx: usize, e: E) -> rusqlite::Error
where
    E: std::error::Error + Send + Sync + 'static,
{
    rusqlite::Error::FromSqlConversionFailure(idx, Type::Text, Box::new(e))
}

pub(crate) fn col_id(r: &Row<'_>, idx: usize) -> rusqlite::Result<Id> {
    let s: String = r.get(idx)?;
    s.parse().map_err(|e| conv_err(idx, e))
}

pub(crate) fn col_opt_id(r: &Row<'_>, idx: usize) -> rusqlite::Result<Option<Id>> {
    let s: Option<String> = r.get(idx)?;
    s.map(|s| s.parse().map_err(|e| conv_err(idx, e)))
        .transpose()
}

pub(crate) fn col_author(r: &Row<'_>, idx: usize) -> rusqlite::Result<Author> {
    let s: String = r.get(idx)?;
    s.parse().map_err(|e| conv_err(idx, e))
}

pub(crate) fn col_opt_author(r: &Row<'_>, idx: usize) -> rusqlite::Result<Option<Author>> {
    let s: Option<String> = r.get(idx)?;
    s.map(|s| s.parse().map_err(|e| conv_err(idx, e)))
        .transpose()
}

pub(crate) fn col_parse<T>(r: &Row<'_>, idx: usize) -> rusqlite::Result<T>
where
    T: std::str::FromStr<Err = crate::error::Error>,
{
    let s: String = r.get(idx)?;
    s.parse().map_err(|e| conv_err(idx, e))
}

pub(crate) fn col_opt_parse<T>(r: &Row<'_>, idx: usize) -> rusqlite::Result<Option<T>>
where
    T: std::str::FromStr<Err = crate::error::Error>,
{
    let s: Option<String> = r.get(idx)?;
    s.map(|s| s.parse().map_err(|e| conv_err(idx, e)))
        .transpose()
}
