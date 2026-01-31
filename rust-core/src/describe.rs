//! LLM-based description generation for di.xml files.
//!
//! Uses the Anthropic Messages API (Claude Sonnet) for generating natural language
//! descriptions of Magento 2 di.xml files.
//! Descriptions are stored in a SQLite database (`sqlite.db`).

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

const ANTHROPIC_API_URL: &str = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL: &str = "claude-sonnet-4-5-20250929";

const SYSTEM_PROMPT: &str = "You are a code documentation assistant specializing in Magento 2 / Adobe Commerce. Your descriptions will be embedded alongside file paths in a semantic search index. Write descriptions that maximize search retrieval — include the key Magento concepts, patterns, class names, and subsystem terms that a developer would search for when looking for this file.";

const USER_PROMPT_TEMPLATE: &str = r#"Describe this Magento 2 di.xml file in 2-3 concise sentences optimized for semantic code search. Your description will be attached to search results so developers can quickly understand what this file configures without reading the XML.

Include:
- The specific DI patterns used (preferences, plugins/interceptors, virtual types, argument injection, type configuration)
- Which interfaces map to which implementations
- Which classes are intercepted by plugins and what behavior they modify
- The Magento subsystem (Catalog, Sales, Checkout, Customer, etc.) and area scope (global, frontend, adminhtml, webapi)

Be specific with class names and Magento concepts. Do not repeat the filename verbatim. Do not include XML snippets.

File: {path}
Content:
{content}"#;

// ─── API request/response types ─────────────────────────────────

#[derive(Serialize)]
struct ApiRequest {
    model: String,
    max_tokens: u32,
    system: String,
    messages: Vec<Message>,
}

#[derive(Serialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ApiResponse {
    content: Vec<ContentBlock>,
}

#[derive(Deserialize)]
struct ContentBlock {
    text: String,
}

#[derive(Deserialize)]
struct ApiError {
    error: Option<ApiErrorDetail>,
}

#[derive(Deserialize)]
struct ApiErrorDetail {
    message: Option<String>,
}

// ─── Description types ──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDescription {
    pub hash: String,
    pub description: String,
    pub model: String,
    pub timestamp: u64,
}

#[derive(Debug)]
pub struct DescribeReport {
    pub total_files: usize,
    pub generated: usize,
    pub skipped: usize,
    pub errors: usize,
    pub described_paths: Vec<String>,
}

// ─── SQLite Description Database ────────────────────────────────

pub struct DescriptionDb {
    conn: Connection,
}

impl DescriptionDb {
    /// Open (or create) the descriptions SQLite database.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)
            .with_context(|| format!("Failed to open descriptions DB at {:?}", path))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS descriptions (
                path        TEXT PRIMARY KEY,
                hash        TEXT NOT NULL,
                description TEXT NOT NULL,
                model       TEXT NOT NULL,
                timestamp   INTEGER NOT NULL
            );",
        )
        .context("Failed to create descriptions table")?;
        Ok(Self { conn })
    }

    /// Open read-only (for indexer lookups).
    pub fn open_readonly(path: &Path) -> Result<Self> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .with_context(|| format!("Failed to open descriptions DB read-only at {:?}", path))?;
        Ok(Self { conn })
    }

    /// Get a single description by relative path.
    pub fn get(&self, path: &str) -> Option<FileDescription> {
        self.conn
            .query_row(
                "SELECT hash, description, model, timestamp FROM descriptions WHERE path = ?1",
                params![path],
                |row| {
                    Ok(FileDescription {
                        hash: row.get(0)?,
                        description: row.get(1)?,
                        model: row.get(2)?,
                        timestamp: row.get::<_, i64>(3)? as u64,
                    })
                },
            )
            .ok()
    }

    /// Insert or replace a description.
    pub fn upsert(
        &self,
        path: &str,
        hash: &str,
        description: &str,
        model: &str,
        timestamp: u64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO descriptions (path, hash, description, model, timestamp) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![path, hash, description, model, timestamp as i64],
        ).context("Failed to upsert description")?;
        Ok(())
    }

    /// Load all descriptions (for MCP server bulk export).
    pub fn all(&self) -> Result<HashMap<String, FileDescription>> {
        let mut stmt = self
            .conn
            .prepare("SELECT path, hash, description, model, timestamp FROM descriptions")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                FileDescription {
                    hash: row.get(1)?,
                    description: row.get(2)?,
                    model: row.get(3)?,
                    timestamp: row.get::<_, i64>(4)? as u64,
                },
            ))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (path, desc) = row?;
            map.insert(path, desc);
        }
        Ok(map)
    }
}

fn compute_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn find_di_xml_files(magento_root: &Path) -> Vec<PathBuf> {
    WalkDir::new(magento_root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_type().is_file()
                && e.file_name().to_str() == Some("di.xml")
        })
        .map(|e| e.into_path())
        .collect()
}

fn relative_path(magento_root: &Path, full_path: &Path) -> String {
    full_path
        .strip_prefix(magento_root)
        .unwrap_or(full_path)
        .to_string_lossy()
        .to_string()
}

fn now_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Generate a description for a single di.xml file via the Anthropic Messages API.
fn generate_description(
    client: &reqwest::blocking::Client,
    api_key: &str,
    model: &str,
    path: &str,
    content: &str,
) -> Result<String> {
    let user_prompt = USER_PROMPT_TEMPLATE
        .replace("{path}", path)
        .replace("{content}", content);

    let request = ApiRequest {
        model: model.to_string(),
        max_tokens: 300,
        system: SYSTEM_PROMPT.to_string(),
        messages: vec![Message {
            role: "user".to_string(),
            content: user_prompt,
        }],
    };

    let mut retries = 0;
    let max_retries = 3;

    loop {
        let resp = client
            .post(ANTHROPIC_API_URL)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&request)
            .send()
            .context("Failed to send request to Anthropic API")?;

        let status = resp.status();

        if status.is_success() {
            let api_resp: ApiResponse = resp.json().context("Failed to parse API response")?;
            let text = api_resp
                .content
                .first()
                .map(|b| b.text.trim().to_string())
                .unwrap_or_default();
            return Ok(text);
        }

        // Retry on 429 (rate limit) or 5xx (server error)
        let should_retry = status.as_u16() == 429 || status.is_server_error();

        if should_retry && retries < max_retries {
            retries += 1;
            let body = resp.text().unwrap_or_default();
            let wait = std::time::Duration::from_secs(1 << retries); // 2s, 4s, 8s
            eprintln!(
                "  API {} (attempt {}/{}), retrying in {}s...",
                status, retries, max_retries, wait.as_secs()
            );
            let _ = body; // consume
            std::thread::sleep(wait);
            continue;
        }

        // Non-retryable error or exhausted retries
        let body = resp.text().unwrap_or_default();
        let msg = serde_json::from_str::<ApiError>(&body)
            .ok()
            .and_then(|e| e.error)
            .and_then(|e| e.message)
            .unwrap_or_else(|| format!("HTTP {}", status));
        anyhow::bail!("Anthropic API error: {}", msg);
    }
}

/// Main entry point: generate descriptions for all di.xml files.
pub fn describe_di_xml_files(
    magento_root: &Path,
    descriptions_path: &Path,
    api_key: &str,
    model: Option<&str>,
    force: bool,
) -> Result<DescribeReport> {
    use indicatif::{ProgressBar, ProgressStyle};

    let model = model.unwrap_or(DEFAULT_MODEL);
    let db = DescriptionDb::open(descriptions_path)?;
    let di_files = find_di_xml_files(magento_root);

    eprintln!("Found {} di.xml files", di_files.len());

    // Determine which files need processing
    let mut to_process: Vec<(String, String, String)> = Vec::new(); // (rel_path, content, hash)
    let mut skipped = 0;

    for path in &di_files {
        let rel = relative_path(magento_root, path);
        let content = match fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        let hash = compute_hash(&content);

        if !force {
            if let Some(existing) = db.get(&rel) {
                if existing.hash == hash {
                    skipped += 1;
                    continue;
                }
            }
        }

        to_process.push((rel, content, hash));
    }

    if to_process.is_empty() {
        eprintln!("All files up to date, nothing to generate.");
        return Ok(DescribeReport {
            total_files: di_files.len(),
            generated: 0,
            skipped,
            errors: 0,
            described_paths: Vec::new(),
        });
    }

    eprintln!("{} files to process, {} skipped (unchanged)", to_process.len(), skipped);
    eprintln!("Using model: {}", model);

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    let pb = ProgressBar::new(to_process.len() as u64);
    pb.set_style(
        ProgressStyle::default_bar()
            .template("[{elapsed_precise}] [{bar:40.green/black}] {pos}/{len} ({eta}) {msg}")
            .unwrap()
            .progress_chars("█▓░"),
    );

    let mut generated = 0;
    let mut errors = 0;
    let mut described_paths = Vec::new();

    for (rel_path, content, hash) in &to_process {
        pb.set_message(rel_path.clone());

        match generate_description(&client, api_key, model, rel_path, content) {
            Ok(description) => {
                if let Err(e) = db.upsert(rel_path, hash, &description, model, now_timestamp()) {
                    eprintln!("\nWarning: failed to save description: {}", e);
                } else {
                    described_paths.push(rel_path.clone());
                }
                generated += 1;
            }
            Err(e) => {
                eprintln!("\nError processing {}: {}", rel_path, e);
                errors += 1;
            }
        }

        pb.inc(1);
    }

    pb.finish_with_message("done");

    let report = DescribeReport {
        total_files: di_files.len(),
        generated,
        skipped,
        errors,
        described_paths,
    };

    eprintln!(
        "\nDescription generation complete: {} generated, {} skipped, {} errors",
        report.generated, report.skipped, report.errors
    );

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_compute_hash() {
        let hash = compute_hash("hello world");
        assert_eq!(hash.len(), 64); // SHA-256 hex
        // Same input produces same hash
        assert_eq!(hash, compute_hash("hello world"));
        // Different input produces different hash
        assert_ne!(hash, compute_hash("hello world!"));
    }

    #[test]
    fn test_description_db_roundtrip() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("descriptions.db");

        let db = DescriptionDb::open(&db_path).unwrap();
        db.upsert("test/di.xml", "abc123", "Test description", "claude-sonnet-4-5", 1234567890)
            .unwrap();

        let desc = db.get("test/di.xml").unwrap();
        assert_eq!(desc.hash, "abc123");
        assert_eq!(desc.description, "Test description");
        assert_eq!(desc.model, "claude-sonnet-4-5");
        assert_eq!(desc.timestamp, 1234567890);

        // Test upsert overwrites
        db.upsert("test/di.xml", "def456", "Updated description", "claude-sonnet-4-5", 1234567891)
            .unwrap();
        let desc = db.get("test/di.xml").unwrap();
        assert_eq!(desc.hash, "def456");
        assert_eq!(desc.description, "Updated description");

        // Test all()
        db.upsert("other/di.xml", "ghi789", "Other description", "claude-sonnet-4-5", 1234567892)
            .unwrap();
        let all = db.all().unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.contains_key("test/di.xml"));
        assert!(all.contains_key("other/di.xml"));
    }

    #[test]
    fn test_description_db_get_missing() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("descriptions.db");
        let db = DescriptionDb::open(&db_path).unwrap();
        assert!(db.get("nonexistent/di.xml").is_none());
    }

    #[test]
    fn test_find_di_xml_files() {
        let dir = tempdir().unwrap();
        let etc_dir = dir.path().join("app/code/Magento/Catalog/etc");
        fs::create_dir_all(&etc_dir).unwrap();
        fs::write(etc_dir.join("di.xml"), "<config></config>").unwrap();

        // Non-di.xml should not be found
        fs::write(etc_dir.join("events.xml"), "<config></config>").unwrap();

        let files = find_di_xml_files(dir.path());
        assert_eq!(files.len(), 1);
        assert!(files[0].to_string_lossy().contains("di.xml"));
    }
}
