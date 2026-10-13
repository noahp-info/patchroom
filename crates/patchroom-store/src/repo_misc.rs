//! Plugins and settings.

use rusqlite::{params, OptionalExtension, Row};

use crate::error::{Error, Result};
use crate::store::{col_author, col_id, new_id, now, Store};
use crate::types::{Author, NewPlugin, Plugin, Setting};

const PLUGIN_COLS: &str = "id, author, created_at, updated_at, name, version, manifest, enabled";
const SETTING_COLS: &str = "id, author, created_at, updated_at, key, value";

/// Substrings that mark a setting key as credential-like. The store refuses
/// them: Patchroom never persists secrets.
const SECRET_HINTS: &[&str] = &[
    "secret",
    "token",
    "password",
    "passwd",
    "api_key",
    "apikey",
    "credential",
    "private_key",
];

fn plugin_row(r: &Row<'_>) -> rusqlite::Result<Plugin> {
    Ok(Plugin {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        name: r.get(4)?,
        version: r.get(5)?,
        manifest: r.get(6)?,
        enabled: r.get(7)?,
    })
}

fn setting_row(r: &Row<'_>) -> rusqlite::Result<Setting> {
    Ok(Setting {
        id: col_id(r, 0)?,
        author: col_author(r, 1)?,
        created_at: r.get(2)?,
        updated_at: r.get(3)?,
        key: r.get(4)?,
        value: r.get(5)?,
    })
}

/// True when `key` looks like it names a credential.
pub fn is_secret_like_key(key: &str) -> bool {
    let k = key.to_lowercase().replace(['-', '.'], "_");
    SECRET_HINTS.iter().any(|h| k.contains(h))
}

impl Store {
    // ---- plugins ----

    /// Install a plugin, or update its version and manifest when the name exists.
    /// Updating keeps the id, creation time and enabled flag.
    pub fn upsert_plugin(&self, author: &Author, new: &NewPlugin) -> Result<Plugin> {
        if new.name.trim().is_empty() {
            return Err(Error::invalid("plugin name must not be empty"));
        }
        let (id, t) = (new_id(), now());
        self.conn.execute(
            "INSERT INTO plugin (id, author, created_at, updated_at, name, version, manifest)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6)
             ON CONFLICT(name) DO UPDATE SET
                 version = excluded.version, manifest = excluded.manifest,
                 updated_at = excluded.updated_at",
            params![
                id.to_string(),
                author.to_string(),
                t,
                new.name,
                new.version,
                new.manifest
            ],
        )?;
        self.plugin_by_name(&new.name)?
            .ok_or_else(|| Error::not_found("plugin", &new.name))
    }

    /// Look a plugin up by name.
    pub fn plugin_by_name(&self, name: &str) -> Result<Option<Plugin>> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {PLUGIN_COLS} FROM plugin WHERE name = ?1"),
                [name],
                plugin_row,
            )
            .optional()?)
    }

    /// All plugins by name.
    pub fn list_plugins(&self) -> Result<Vec<Plugin>> {
        let mut st = self
            .conn
            .prepare(&format!("SELECT {PLUGIN_COLS} FROM plugin ORDER BY name"))?;
        let rows = st.query_map([], plugin_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Enable or disable a plugin.
    pub fn set_plugin_enabled(&self, name: &str, enabled: bool) -> Result<Plugin> {
        let n = self.conn.execute(
            "UPDATE plugin SET enabled = ?2, updated_at = ?3 WHERE name = ?1",
            params![name, enabled, now()],
        )?;
        if n == 0 {
            return Err(Error::not_found("plugin", name));
        }
        self.plugin_by_name(name)?
            .ok_or_else(|| Error::not_found("plugin", name))
    }

    /// Uninstall a plugin.
    pub fn remove_plugin(&self, name: &str) -> Result<()> {
        let n = self
            .conn
            .execute("DELETE FROM plugin WHERE name = ?1", [name])?;
        if n == 0 {
            return Err(Error::not_found("plugin", name));
        }
        Ok(())
    }

    // ---- settings ----

    /// Write a setting. Keys that look like credentials are refused.
    pub fn set_setting(&self, author: &Author, key: &str, value: &str) -> Result<Setting> {
        if key.trim().is_empty() {
            return Err(Error::invalid("setting key must not be empty"));
        }
        if is_secret_like_key(key) {
            return Err(Error::invalid(format!(
                "setting key {key:?} looks like a credential; Patchroom never stores secrets"
            )));
        }
        let (id, t) = (new_id(), now());
        self.conn.execute(
            "INSERT INTO setting (id, author, created_at, updated_at, key, value)
             VALUES (?1, ?2, ?3, ?3, ?4, ?5)
             ON CONFLICT(key) DO UPDATE SET
                 value = excluded.value, author = excluded.author, updated_at = excluded.updated_at",
            params![id.to_string(), author.to_string(), t, key, value],
        )?;
        self.setting(key)?
            .ok_or_else(|| Error::not_found("setting", key))
    }

    /// Fetch a setting row.
    pub fn setting(&self, key: &str) -> Result<Option<Setting>> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {SETTING_COLS} FROM setting WHERE key = ?1"),
                [key],
                setting_row,
            )
            .optional()?)
    }

    /// Just the value of a setting.
    pub fn setting_value(&self, key: &str) -> Result<Option<String>> {
        Ok(self.setting(key)?.map(|s| s.value))
    }

    /// All settings by key.
    pub fn list_settings(&self) -> Result<Vec<Setting>> {
        let mut st = self
            .conn
            .prepare(&format!("SELECT {SETTING_COLS} FROM setting ORDER BY key"))?;
        let rows = st.query_map([], setting_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Delete a setting; returns whether it existed.
    pub fn delete_setting(&self, key: &str) -> Result<bool> {
        Ok(self
            .conn
            .execute("DELETE FROM setting WHERE key = ?1", [key])?
            > 0)
    }
}
