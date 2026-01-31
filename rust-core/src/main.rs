//! Magector CLI - Magento code indexer and search tool

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use magector_core::{Indexer, VectorDB, Embedder, Validator, WatcherStatus, EMBEDDING_DIM};

const MAGENTO2_REPO: &str = "https://github.com/magento/magento2.git";
const MAGENTO2_TAG: &str = "2.4.7"; // Latest stable version

#[derive(Parser)]
#[command(name = "magector")]
#[command(about = "Magento source code indexer with semantic search")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// Verbose output
    #[arg(short, long, global = true)]
    verbose: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Index a Magento codebase
    Index {
        /// Path to Magento root directory
        #[arg(short, long)]
        magento_root: PathBuf,

        /// Path to store the index database
        #[arg(short, long, default_value = "./magector.db")]
        database: PathBuf,

        /// Path to cache embedding model
        #[arg(short = 'c', long, default_value = "./models")]
        model_cache: PathBuf,
    },

    /// Search the index
    Search {
        /// Search query
        query: String,

        /// Path to the index database
        #[arg(short, long, default_value = "./magector.db")]
        database: PathBuf,

        /// Path to cache embedding model
        #[arg(short = 'c', long, default_value = "./models")]
        model_cache: PathBuf,

        /// Number of results to return
        #[arg(short, long, default_value = "10")]
        limit: usize,

        /// Output format (text, json)
        #[arg(short, long, default_value = "text")]
        format: String,
    },

    /// Generate embedding for text (for JS integration)
    Embed {
        /// Text to embed
        #[arg(short, long)]
        text: String,

        /// Path to cache embedding model
        #[arg(short = 'c', long, default_value = "./models")]
        model_cache: PathBuf,
    },

    /// Show index statistics
    Stats {
        /// Path to the index database
        #[arg(short, long, default_value = "./magector.db")]
        database: PathBuf,
    },

    /// Run comprehensive validation against Magento 2
    Validate {
        /// Path to Magento root directory (downloads if not specified)
        #[arg(short, long)]
        magento_root: Option<PathBuf>,

        /// Path to store the index database
        #[arg(short, long, default_value = "./validation.db")]
        database: PathBuf,

        /// Path to cache embedding model
        #[arg(short = 'c', long, default_value = "./models")]
        model_cache: PathBuf,

        /// Path to save validation report (JSON)
        #[arg(short, long, default_value = "./validation_report.json")]
        report: PathBuf,

        /// Skip re-indexing if index exists
        #[arg(short, long)]
        skip_index: bool,
    },

    /// Download Magento 2 Open Source
    Download {
        /// Target directory
        #[arg(short, long, default_value = "./magento2")]
        target: PathBuf,

        /// Magento version tag (default: latest stable)
        #[arg(short, long)]
        version: Option<String>,
    },

    /// Start persistent server mode (reads JSON queries from stdin, writes JSON results to stdout)
    Serve {
        /// Path to the index database
        #[arg(short, long, default_value = "./magector.db")]
        database: PathBuf,

        /// Path to cache embedding model
        #[arg(short = 'c', long, default_value = "./models")]
        model_cache: PathBuf,

        /// Path to Magento root directory (enables file watcher for incremental re-indexing)
        #[arg(short, long)]
        magento_root: Option<PathBuf>,

        /// File watcher poll interval in seconds (default: 60)
        #[arg(long, default_value = "60")]
        watch_interval: u64,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    // Initialize logging — always write to stderr to avoid polluting stdout (MCP/JSON)
    let filter = if cli.verbose {
        "debug"
    } else {
        "magector_core=info,warn"
    };
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(filter))
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .init();

    match cli.command {
        Commands::Index {
            magento_root,
            database,
            model_cache,
        } => {
            run_index(&magento_root, &database, &model_cache)?;
        }

        Commands::Search {
            query,
            database,
            model_cache,
            limit,
            format,
        } => {
            let mut indexer = Indexer::new(&PathBuf::new(), &model_cache, &database)?;

            let results = indexer.search(&query, limit)?;

            if format == "json" {
                println!("{}", serde_json::to_string_pretty(&results)?);
            } else {
                println!("\n=== Search Results for: \"{}\" ===\n", query);
                for (i, result) in results.iter().enumerate() {
                    println!(
                        "{}. {} (score: {:.3})",
                        i + 1,
                        result.metadata.path,
                        result.score
                    );
                    if let Some(ref class) = result.metadata.class_name {
                        println!("   Class: {}", class);
                    }
                    if let Some(ref mtype) = result.metadata.magento_type {
                        println!("   Type: {}", mtype);
                    }
                    println!();
                }
            }
        }

        Commands::Embed { text, model_cache } => {
            let mut embedder = Embedder::from_pretrained(&model_cache)?;
            let embedding = embedder.embed(&text)?;

            // Output as JSON array for easy parsing
            println!("{}", serde_json::to_string(&embedding)?);
        }

        Commands::Stats { database } => {
            let db = VectorDB::open(&database)?;

            println!("\n=== Index Statistics ===");
            println!("Total vectors: {}", db.len());
            println!("Embedding dim: {}", EMBEDDING_DIM);
        }

        Commands::Validate {
            magento_root,
            database,
            model_cache,
            report,
            skip_index,
        } => {
            run_validation(magento_root, &database, &model_cache, &report, skip_index)?;
        }

        Commands::Download { target, version } => {
            download_magento(&target, version.as_deref())?;
        }

        Commands::Serve {
            database,
            model_cache,
            magento_root,
            watch_interval,
        } => {
            run_serve(&database, &model_cache, magento_root, watch_interval)?;
        }
    }

    Ok(())
}

fn run_index(magento_root: &PathBuf, database: &PathBuf, model_cache: &PathBuf) -> Result<()> {
    tracing::info!("Starting indexer...");

    let mut indexer = Indexer::new(magento_root, model_cache, database)?;

    let stats = indexer.index()?;

    tracing::info!("Saving index to {:?}...", database);
    indexer.save(database)?;

    println!("Files found:    {}", stats.files_found);
    println!("Files indexed:  {}", stats.files_indexed);
    println!("  PHP files:    {}", stats.php_files);
    println!("  JS files:     {}", stats.js_files);
    println!("  XML files:    {}", stats.xml_files);
    println!("  Other:        {}", stats.other_files);
    println!("Files skipped:  {}", stats.files_skipped);
    println!("Vectors created: {}", stats.vectors_created);
    println!("Errors:         {}", stats.errors);

    Ok(())
}

fn run_validation(
    magento_root: Option<PathBuf>,
    database: &PathBuf,
    model_cache: &PathBuf,
    report_path: &PathBuf,
    skip_index: bool,
) -> Result<()> {
    println!("\n╔═══════════════════════════════════════════════════════════╗");
    println!("║          MAGECTOR COMPREHENSIVE VALIDATION                ║");
    println!("╚═══════════════════════════════════════════════════════════╝\n");

    // Determine Magento root
    let magento_path = match magento_root {
        Some(path) => {
            println!("Using provided Magento root: {:?}", path);
            path
        }
        None => {
            // Check if magento2 already exists
            let default_path = PathBuf::from("./magento2");
            if default_path.exists() {
                println!("Using existing Magento 2 at: {:?}", default_path);
                default_path
            } else {
                println!("Magento 2 not found. Downloading...");
                download_magento(&default_path, None)?;
                default_path
            }
        }
    };

    // Check if we need to index
    let db_exists = database.exists();

    if skip_index && db_exists {
        println!("Using existing index at {:?}", database);
    } else {
        println!("\nIndexing Magento codebase...\n");
        run_index(&magento_path, database, model_cache)?;
    }

    // Load indexer for search
    println!("\nLoading index for validation...");
    let mut indexer = Indexer::new(&magento_path, model_cache, database)?;

    // Run validation
    let validator = Validator::new();
    let report = validator.run(&mut indexer)?;

    // Save report
    validator.save_report(&report, report_path)?;

    // Final summary
    println!("\n╔═══════════════════════════════════════════════════════════╗");
    println!("║                    FINAL RESULTS                          ║");
    println!("╚═══════════════════════════════════════════════════════════╝\n");

    println!("📊 Overall Accuracy: {:.1}%", report.accuracy);
    println!("✓ Tests Passed: {}/{}", report.passed, report.total_tests);
    println!("✗ Tests Failed: {}", report.failed);
    println!("📁 Index Size: {} vectors", report.index_size);
    println!("⏱  Total Time: {} ms", report.total_time_ms);
    println!("\n📄 Full report saved to: {:?}", report_path);

    if report.accuracy >= 90.0 {
        println!("\n🎉 Excellent accuracy! The indexer is performing well.");
    } else if report.accuracy >= 70.0 {
        println!("\n⚠️  Good accuracy, but there's room for improvement.");
    } else {
        println!("\n❌ Accuracy below target. Review recommendations in the report.");
    }

    Ok(())
}

/// Persistent serve mode: load model+index once, handle JSON queries from stdin.
///
/// Protocol (one JSON object per line):
///   Request:  {"command":"search","query":"...","limit":10}
///   Request:  {"command":"stats"}
///   Request:  {"command":"watcher_status"}
///   Response: {"ok":true,"data":...}
///   Error:    {"ok":false,"error":"..."}
fn run_serve(
    database: &PathBuf,
    model_cache: &PathBuf,
    magento_root: Option<PathBuf>,
    watch_interval: u64,
) -> Result<()> {
    eprintln!("Loading model and index for serve mode...");
    let mg_root = magento_root.clone().unwrap_or_default();
    let indexer = Indexer::new(&mg_root, model_cache, database)?;
    let vectors = indexer.stats().vectors_created;
    let indexer = Arc::new(Mutex::new(indexer));

    // Watcher status (shared with watcher thread)
    let watcher_status = Arc::new(Mutex::new(WatcherStatus {
        running: false,
        tracked_files: 0,
        last_scan_changes: 0,
        interval_secs: watch_interval,
    }));

    // Spawn file watcher thread if magento_root is provided
    if let Some(ref root) = magento_root {
        let idx = Arc::clone(&indexer);
        let root = root.clone();
        let db = database.clone();
        let interval = Duration::from_secs(watch_interval);
        let status = Arc::clone(&watcher_status);

        {
            let mut s = status.lock().unwrap();
            s.running = true;
        }

        std::thread::Builder::new()
            .name("file-watcher".to_string())
            .spawn(move || {
                magector_core::watcher_loop(idx, root, db, interval, status);
            })
            .context("Failed to spawn watcher thread")?;

        eprintln!("File watcher enabled (interval: {}s)", watch_interval);
    }

    eprintln!("Ready. Listening on stdin for JSON queries.");

    // Signal readiness with a JSON line on stdout
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());
    let watcher_running = magento_root.is_some();
    writeln!(
        out,
        r#"{{"ok":true,"ready":true,"vectors":{},"watcher":{}}}"#,
        vectors, watcher_running
    )?;
    out.flush()?;

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<serde_json::Value>(&line) {
            Ok(req) => {
                // Catch panics to prevent serve process death
                let indexer_ref = &indexer;
                let watcher_ref = &watcher_status;
                let db_ref = database;
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    handle_serve_request(
                        indexer_ref,
                        watcher_ref,
                        db_ref,
                        &req,
                    )
                })) {
                    Ok(resp) => resp,
                    Err(_) => {
                        eprintln!("Panic caught in request handler, serve process continues");
                        r#"{"ok":false,"error":"Internal panic caught"}"#.to_string()
                    }
                }
            }
            Err(e) => format!(r#"{{"ok":false,"error":"Invalid JSON: {}"}}"#, e),
        };

        writeln!(out, "{}", response)?;
        out.flush()?;
    }

    Ok(())
}

fn handle_serve_request(
    indexer: &Arc<Mutex<Indexer>>,
    watcher_status: &Arc<Mutex<WatcherStatus>>,
    db_path: &PathBuf,
    req: &serde_json::Value,
) -> String {
    let command = req.get("command").and_then(|v| v.as_str()).unwrap_or("");

    match command {
        "search" => {
            let query = match req.get("query").and_then(|v| v.as_str()) {
                Some(q) => q,
                None => return r#"{"ok":false,"error":"Missing 'query' field"}"#.to_string(),
            };
            let limit = req.get("limit").and_then(|v| v.as_u64()).unwrap_or(10) as usize;

            let mut idx = indexer.lock().unwrap();

            let mut results = match idx.search(query, limit) {
                Ok(r) => r,
                Err(e) => return format!(r#"{{"ok":false,"error":"Search error: {}"}}"#, e),
            };

            results.truncate(limit);

            match serde_json::to_string(&results) {
                Ok(json) => format!(r#"{{"ok":true,"data":{}}}"#, json),
                Err(e) => format!(r#"{{"ok":false,"error":"Serialize error: {}"}}"#, e),
            }
        }
        "stats" => {
            let idx = indexer.lock().unwrap();
            let stats = idx.stats();
            format!(r#"{{"ok":true,"data":{{"vectors":{}}}}}"#, stats.vectors_created)
        }
        "watcher_status" => {
            let s = watcher_status.lock().unwrap();
            match serde_json::to_string(&*s) {
                Ok(json) => format!(r#"{{"ok":true,"data":{}}}"#, json),
                Err(e) => format!(r#"{{"ok":false,"error":"Serialize error: {}"}}"#, e),
            }
        }
        "feedback" => {
            let signals: Vec<magector_core::sona::SonaSignal> = match req.get("signals") {
                Some(v) => serde_json::from_value(v.clone()).unwrap_or_default(),
                None => vec![],
            };
            if signals.is_empty() {
                return r#"{"ok":true,"data":{"learned":0}}"#.to_string();
            }
            let mut idx = indexer.lock().unwrap();
            for signal in &signals {
                // Re-embed the query for LoRA training
                let query = if signal.query.is_empty() {
                    signal.original_query.as_deref().unwrap_or("")
                } else {
                    &signal.query
                };
                let query_emb = if !query.is_empty() {
                    idx.embed_query(query).ok()
                } else {
                    None
                };
                if let Some(ref mut sona) = idx.sona {
                    if let Some(ref qe) = query_emb {
                        // Use query as its own target for self-supervised LoRA learning
                        sona.learn_with_embeddings(signal, Some(qe), Some(qe));
                    } else {
                        sona.learn(signal);
                    }
                }
            }
            if let Some(ref sona) = idx.sona {
                let sona_path = db_path.with_extension("sona");
                let _ = sona.save(&sona_path);
            }
            format!(r#"{{"ok":true,"data":{{"learned":{}}}}}"#, signals.len())
        }

        "sona_status" => {
            let idx = indexer.lock().unwrap();
            let patterns = idx.sona.as_ref()
                .map(|s| s.learned.adjustments.len()).unwrap_or(0);
            let observations: u32 = idx.sona.as_ref()
                .map(|s| s.learned.counts.values().sum()).unwrap_or(0);
            let term_patterns = idx.sona.as_ref()
                .map(|s| s.learned.term_adjustments.len()).unwrap_or(0);
            let global_count = idx.sona.as_ref()
                .map(|s| s.learned.global_count).unwrap_or(0);
            format!(r#"{{"ok":true,"data":{{"learned_patterns":{},"total_observations":{},"term_patterns":{},"global_observations":{}}}}}"#, patterns, observations, term_patterns, global_count)
        }

        _ => format!(r#"{{"ok":false,"error":"Unknown command: {}"}}"#, command),
    }
}

fn download_magento(target: &PathBuf, version: Option<&str>) -> Result<()> {
    let tag = version.unwrap_or(MAGENTO2_TAG);

    println!("\n╔═══════════════════════════════════════════════════════════╗");
    println!("║           DOWNLOADING MAGENTO 2 OPEN SOURCE               ║");
    println!("╚═══════════════════════════════════════════════════════════╝\n");

    println!("Repository: {}", MAGENTO2_REPO);
    println!("Version: {}", tag);
    println!("Target: {:?}\n", target);

    if target.exists() {
        println!("Target directory already exists. Checking for updates...");

        // Try to checkout the specific tag
        let status = Command::new("git")
            .args(["-C", target.to_str().unwrap(), "fetch", "--tags"])
            .status()
            .context("Failed to run git fetch")?;

        if status.success() {
            let checkout = Command::new("git")
                .args(["-C", target.to_str().unwrap(), "checkout", tag])
                .status()
                .context("Failed to checkout tag")?;

            if checkout.success() {
                println!("✓ Checked out tag: {}", tag);
                return Ok(());
            }
        }

        println!("Warning: Could not update existing repository");
        return Ok(());
    }

    // Create parent directory
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }

    println!("Cloning repository (this may take a few minutes)...\n");

    // Clone with specific tag (shallow clone for speed)
    let status = Command::new("git")
        .args([
            "clone",
            "--depth", "1",
            "--branch", tag,
            MAGENTO2_REPO,
            target.to_str().unwrap(),
        ])
        .status()
        .context("Failed to run git clone")?;

    if !status.success() {
        anyhow::bail!("Git clone failed");
    }

    println!("\n✓ Magento 2 downloaded successfully to {:?}", target);

    // Count files
    let mut php_count = 0;
    let mut js_count = 0;
    let mut xml_count = 0;

    for entry in walkdir::WalkDir::new(target)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            match entry.path().extension().and_then(|e| e.to_str()) {
                Some("php") | Some("phtml") => php_count += 1,
                Some("js") => js_count += 1,
                Some("xml") => xml_count += 1,
                _ => {}
            }
        }
    }

    println!("\nRepository contents:");
    println!("  PHP/PHTML files: {}", php_count);
    println!("  JavaScript files: {}", js_count);
    println!("  XML files: {}", xml_count);

    Ok(())
}
