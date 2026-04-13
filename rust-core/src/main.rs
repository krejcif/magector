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
use magector_core::datadb::DataDb;

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
        #[arg(short, long, default_value = "./.magector/index.db")]
        database: PathBuf,

        /// Path to cache embedding model
        #[arg(short = 'c', long, default_value = "./models")]
        model_cache: PathBuf,

        /// Path to descriptions SQLite DB (descriptions are prepended to embeddings)
        #[arg(long)]
        descriptions_db: Option<PathBuf>,

        /// Max ONNX threads (default: half of CPU cores). Also via MAGECTOR_THREADS env var.
        #[arg(long)]
        threads: Option<usize>,

        /// Embedding batch size (default: 256). Also via MAGECTOR_BATCH_SIZE env var.
        #[arg(long)]
        batch_size: Option<usize>,

        /// Force full re-index, discarding any existing index on disk.
        /// Without this flag, indexing auto-resumes from the previous run.
        #[arg(long)]
        force: bool,
    },

    /// Search the index
    Search {
        /// Search query
        query: String,

        /// Path to the index database
        #[arg(short, long, default_value = "./.magector/index.db")]
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
        #[arg(short, long, default_value = "./.magector/index.db")]
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

    /// Generate LLM descriptions for di.xml files
    Describe {
        /// Path to Magento root directory
        #[arg(short, long)]
        magento_root: PathBuf,

        /// Path to store the descriptions SQLite database
        #[arg(short = 'o', long, default_value = "./.magector/sqlite.db")]
        output: PathBuf,

        /// Anthropic API key (falls back to ANTHROPIC_API_KEY env var)
        #[arg(long)]
        api_key: Option<String>,

        /// Model to use for description generation
        #[arg(long)]
        model: Option<String>,

        /// Force regeneration of all descriptions (ignore cache)
        #[arg(long)]
        force: bool,
    },

    /// Start persistent server mode (reads JSON queries from stdin, writes JSON results to stdout)
    Serve {
        /// Path to the index database
        #[arg(short, long, default_value = "./.magector/index.db")]
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

        /// Path to descriptions SQLite DB (descriptions are prepended to embeddings)
        #[arg(long)]
        descriptions_db: Option<PathBuf>,

        /// Max ONNX threads (default: half of CPU cores). Also via MAGECTOR_THREADS env var.
        #[arg(long)]
        threads: Option<usize>,
    },
}

/// Resolve the global thread limit from (in priority order):
///   1. Explicit `--threads` flag
///   2. `MAGECTOR_THREADS` env var
///   3. `OMP_NUM_THREADS` env var
/// Returns `None` if nothing is set (callers should fall back to their own default).
fn resolve_thread_limit(explicit: Option<usize>) -> Option<usize> {
    explicit
        .or_else(|| std::env::var("MAGECTOR_THREADS").ok().and_then(|v| v.parse().ok()))
        .or_else(|| std::env::var("OMP_NUM_THREADS").ok().and_then(|v| v.parse().ok()))
}

/// Configure the global rayon thread pool. Must be called before any parallel work
/// happens (otherwise rayon initializes its default pool with all CPU cores).
/// Idempotent failure: if rayon is already initialized we log a warning and continue.
fn configure_rayon(threads: usize) {
    let available = num_cpus::get().max(1);
    let n = threads.max(1).min(available);
    match rayon::ThreadPoolBuilder::new().num_threads(n).build_global() {
        Ok(()) => tracing::info!("Rayon global pool: {} threads (available: {})", n, available),
        Err(e) => tracing::warn!("Could not set rayon thread count to {}: {}", n, e),
    }
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

    // Configure rayon early — must happen before any par_iter() in PHASE 1.
    // For Index/Serve we honor --threads; for other commands we fall back to env vars only.
    let cmd_threads = match &cli.command {
        Commands::Index { threads, .. } => *threads,
        Commands::Serve { threads, .. } => *threads,
        _ => None,
    };
    if let Some(n) = resolve_thread_limit(cmd_threads) {
        configure_rayon(n);
    }

    match cli.command {
        Commands::Index {
            magento_root,
            database,
            model_cache,
            descriptions_db,
            threads,
            batch_size,
            force,
        } => {
            run_index(&magento_root, &database, &model_cache, descriptions_db.as_deref(), threads, batch_size, force)?;
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

        Commands::Describe {
            magento_root,
            output,
            api_key,
            model,
            force,
        } => {
            let api_key = api_key
                .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
                .unwrap_or_else(|| {
                    eprintln!("Error: No API key provided. Use --api-key or set ANTHROPIC_API_KEY env var.");
                    std::process::exit(1);
                });
            let report = magector_core::describe::describe_di_xml_files(
                &magento_root,
                &output,
                &api_key,
                model.as_deref(),
                force,
            )?;
            println!("Total di.xml files: {}", report.total_files);
            println!("Generated:          {}", report.generated);
            println!("Skipped:            {}", report.skipped);
            println!("Errors:             {}", report.errors);
        }

        Commands::Download { target, version } => {
            download_magento(&target, version.as_deref())?;
        }

        Commands::Serve {
            database,
            model_cache,
            magento_root,
            watch_interval,
            descriptions_db,
            threads,
        } => {
            run_serve(&database, &model_cache, magento_root, watch_interval, descriptions_db, threads)?;
        }
    }

    Ok(())
}

fn run_index(
    magento_root: &PathBuf,
    database: &PathBuf,
    model_cache: &PathBuf,
    descriptions_db: Option<&std::path::Path>,
    threads: Option<usize>,
    batch_size: Option<usize>,
    force: bool,
) -> Result<()> {
    tracing::info!("Starting indexer...");

    let mut indexer = Indexer::with_options(magento_root, model_cache, database, threads, batch_size)?;

    // Auto-detect descriptions DB next to the main DB if not explicitly provided
    let desc_db_path = descriptions_db.map(|p| p.to_path_buf()).unwrap_or_else(|| {
        database.with_file_name("sqlite.db")
    });
    if desc_db_path.exists() {
        tracing::info!("Using descriptions DB: {:?}", desc_db_path);
        indexer.set_descriptions_db(desc_db_path);
    }

    let stats = indexer.index_with_options(force)?;

    tracing::info!("Saving final index to {:?}...", database);
    indexer.save_atomic(database)?;

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
        // Validation runs always start fresh so results are reproducible.
        run_index(&magento_path, database, model_cache, None, None, None, true)?;
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
    descriptions_db: Option<PathBuf>,
    threads: Option<usize>,
) -> Result<()> {
    eprintln!("Loading model and index for serve mode...");
    let mg_root = magento_root.clone().unwrap_or_default();
    let mut indexer = Indexer::with_options(&mg_root, model_cache, database, threads, None)?;

    // Auto-detect descriptions DB
    let desc_db_path = descriptions_db.unwrap_or_else(|| {
        database.with_file_name("sqlite.db")
    });
    if desc_db_path.exists() {
        eprintln!("Using descriptions DB: {:?}", desc_db_path);
        indexer.set_descriptions_db(desc_db_path.clone());
    }
    let desc_db_path_for_serve = desc_db_path;
    let vectors = indexer.stats().vectors_created;
    let indexer = Arc::new(Mutex::new(indexer));

    // Open (or create) the unified DataDb alongside the index
    let data_db_path = database.with_file_name("data.db");
    let data_db = DataDb::open(&data_db_path)
        .with_context(|| format!("Failed to open DataDb at {:?}", data_db_path))?;
    let data_db = Arc::new(Mutex::new(data_db));
    eprintln!("DataDb opened at {:?}", data_db_path);

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

    // Write own PID to data.db so Node.js can discover us via DB query
    {
        let ddb = data_db.lock().unwrap();
        let pid = std::process::id();
        let version = env!("CARGO_PKG_VERSION");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        if let Err(e) = ddb.process_set("serve", pid, Some(version), now) {
            eprintln!("Warning: failed to write serve PID to DataDb: {}", e);
        } else {
            eprintln!("Registered serve process PID {} (v{}) in DataDb", pid, version);
        }
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
                let desc_db_ref = &desc_db_path_for_serve;
                let data_db_ref = &data_db;
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    handle_serve_request(
                        indexer_ref,
                        watcher_ref,
                        db_ref,
                        desc_db_ref,
                        data_db_ref,
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
    desc_db_path: &PathBuf,
    data_db: &Arc<Mutex<DataDb>>,
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

        "describe" => {
            let mg_root = req.get("magento_root").and_then(|v| v.as_str()).unwrap_or("");
            let output = req.get("output").and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| desc_db_path.to_string_lossy().to_string());
            let force = req.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            let api_key = req.get("api_key").and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok());
            let model = req.get("model").and_then(|v| v.as_str());

            if mg_root.is_empty() {
                return r#"{"ok":false,"error":"Missing 'magento_root' field"}"#.to_string();
            }

            let api_key = match api_key {
                Some(k) => k,
                None => return r#"{"ok":false,"error":"No API key. Set ANTHROPIC_API_KEY env var."}"#.to_string(),
            };

            match magector_core::describe::describe_di_xml_files(
                std::path::Path::new(mg_root),
                std::path::Path::new(&output),
                &api_key,
                model,
                force,
            ) {
                Ok(report) => {
                    // Auto-reindex described files so descriptions are embedded
                    if !report.described_paths.is_empty() {
                        let mg_root_path = std::path::Path::new(mg_root);
                        let files_to_reindex: Vec<std::path::PathBuf> = report.described_paths.iter()
                            .map(|p| mg_root_path.join(p))
                            .filter(|p| p.exists())
                            .collect();
                        if !files_to_reindex.is_empty() {
                            let mut idx = indexer.lock().unwrap();
                            // Ensure descriptions DB is set for re-embedding
                            idx.set_descriptions_db(std::path::PathBuf::from(&output));
                            // Remove old vectors for these paths
                            for rel_path in &report.described_paths {
                                idx.remove_vectors_for_path(rel_path);
                            }
                            let reindex_result: Result<Vec<(String, Vec<usize>)>> = idx.index_files(&files_to_reindex);
                            match reindex_result {
                                Ok(indexed) => {
                                    eprintln!("Re-indexed {} files with descriptions", indexed.len());
                                    if let Err(e) = idx.save(db_path) {
                                        eprintln!("Warning: failed to save index after re-embed: {}", e);
                                    }
                                }
                                Err(e) => {
                                    eprintln!("Warning: re-index after describe failed: {}", e);
                                }
                            }
                        }
                    }
                    format!(
                        r#"{{"ok":true,"data":{{"total_files":{},"generated":{},"skipped":{},"errors":{}}}}}"#,
                        report.total_files, report.generated, report.skipped, report.errors
                    )
                }
                Err(e) => format!(r#"{{"ok":false,"error":"Describe error: {}"}}"#, e),
            }
        }

        "descriptions" => {
            // Return all descriptions as JSON — try DataDb first, fall back to legacy DescriptionDb
            let ddb = data_db.lock().unwrap();
            match ddb.desc_all() {
                Ok(all) if !all.is_empty() => {
                    match serde_json::to_string(&all) {
                        Ok(json) => format!(r#"{{"ok":true,"data":{}}}"#, json),
                        Err(e) => format!(r#"{{"ok":false,"error":"Serialize error: {}"}}"#, e),
                    }
                }
                _ => {
                    // Fall back to legacy DescriptionDb
                    drop(ddb);
                    if !desc_db_path.exists() {
                        return r#"{"ok":true,"data":{}}"#.to_string();
                    }
                    match magector_core::describe::DescriptionDb::open_readonly(desc_db_path) {
                        Ok(db) => {
                            match db.all() {
                                Ok(all) => {
                                    match serde_json::to_string(&all) {
                                        Ok(json) => format!(r#"{{"ok":true,"data":{}}}"#, json),
                                        Err(e) => format!(r#"{{"ok":false,"error":"Serialize error: {}"}}"#, e),
                                    }
                                }
                                Err(e) => format!(r#"{{"ok":false,"error":"DB read error: {}"}}"#, e),
                            }
                        }
                        Err(e) => format!(r#"{{"ok":false,"error":"DB open error: {}"}}"#, e),
                    }
                }
            }
        }

        "enrich" => {
            let mg_root = match req.get("magento_root").and_then(|v| v.as_str()) {
                Some(r) if !r.is_empty() => r,
                _ => return r#"{"ok":false,"error":"Missing 'magento_root' field"}"#.to_string(),
            };

            // Scan vendor/**/*.php for method chains
            let pattern = format!("{}/vendor/**/*.php", mg_root);
            let php_files: Vec<_> = match glob::glob(&pattern) {
                Ok(paths) => paths.filter_map(|p| p.ok()).collect(),
                Err(e) => return format!(r#"{{"ok":false,"error":"Glob error: {}"}}"#, e),
            };

            let chain_re = match regex::Regex::new(r"\$(\w+)\s*->\s*(\w+)\s*\([^)]{0,60}\)\s*->\s*(\w+)\s*\(") {
                Ok(r) => r,
                Err(e) => return format!(r#"{{"ok":false,"error":"Regex error: {}"}}"#, e),
            };

            // Null guard patterns for window scanning
            let null_safe_arrow = "?->";
            let null_coalesce_re = regex::Regex::new(r"\?\?|\?:").unwrap();

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;

            let mut scanned: usize = 0;
            let mut chains: usize = 0;
            let mg_root_prefix = format!("{}/", mg_root);

            let ddb = data_db.lock().unwrap();
            if let Err(e) = ddb.begin() {
                return format!(r#"{{"ok":false,"error":"Transaction begin failed: {}"}}"#, e);
            }
            if let Err(e) = ddb.enrich_clear() {
                let _ = ddb.rollback();
                return format!(r#"{{"ok":false,"error":"Clear failed: {}"}}"#, e);
            }

            for php_file in &php_files {
                let content = match std::fs::read_to_string(php_file) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                if !content.contains("->") {
                    continue;
                }

                let rel_path = php_file.to_string_lossy()
                    .strip_prefix(&mg_root_prefix)
                    .unwrap_or(&php_file.to_string_lossy())
                    .to_string();

                let lines: Vec<&str> = content.lines().collect();

                // Build line offset index for O(1) line number lookup
                let mut line_offsets = vec![0usize];
                for (i, ch) in content.as_bytes().iter().enumerate() {
                    if *ch == b'\n' {
                        line_offsets.push(i + 1);
                    }
                }

                for cap in chain_re.captures_iter(&content) {
                    let match_start = cap.get(0).unwrap().start();
                    // Binary search for line number
                    let line_num = match line_offsets.binary_search(&match_start) {
                        Ok(i) => i + 1,
                        Err(i) => i, // i is the insertion point, which equals 1-based line number
                    };

                    let receiver = cap.get(1).map(|m| m.as_str()).unwrap_or("");
                    let first_method = cap.get(2).map(|m| m.as_str()).unwrap_or("");
                    let second_method = cap.get(3).map(|m| m.as_str()).unwrap_or("");
                    let chain_str = format!("->{first_method}()->{second_method}()");

                    // Check null guard in ±6 lines
                    let guard_radius: usize = 6;
                    let match_line_idx = if line_num > 0 { line_num - 1 } else { 0 };
                    let start_idx = match_line_idx.saturating_sub(guard_radius);
                    let end_idx = (match_line_idx + guard_radius).min(lines.len().saturating_sub(1));
                    let match_line = lines.get(match_line_idx).copied().unwrap_or("");
                    let window: String = lines[start_idx..=end_idx].join("\n");

                    let has_guard = {
                        // ?-> on the match line
                        match_line.contains(null_safe_arrow)
                        // ?? or ?: in window
                        || null_coalesce_re.is_match(&window)
                        // receiver-specific checks
                        || {
                            if !receiver.is_empty() {
                                let recv = format!("${}", receiver);
                                let escaped = regex::escape(&recv);
                                // Check: is_null($recv), $recv === null, $recv !== null, !$recv, isset($recv)
                                let pat = format!(
                                    r"(?i)(?:is_null\s*\(\s*{}|{}\s*(?:===|!==)\s*null|!\s*{}\s*[,)]|isset\s*\(\s*{})",
                                    escaped, escaped, escaped, escaped
                                );
                                regex::Regex::new(&pat)
                                    .map(|re| re.is_match(&window))
                                    .unwrap_or(false)
                            } else {
                                false
                            }
                        }
                    };

                    if let Err(e) = ddb.enrich_insert(
                        &rel_path,
                        line_num as i64,
                        &chain_str,
                        first_method,
                        second_method,
                        has_guard,
                        now,
                    ) {
                        let _ = ddb.rollback();
                        return format!(r#"{{"ok":false,"error":"Insert failed: {}"}}"#, e);
                    }
                    chains += 1;
                }
                scanned += 1;
            }

            if let Err(e) = ddb.commit() {
                return format!(r#"{{"ok":false,"error":"Commit failed: {}"}}"#, e);
            }

            format!(r#"{{"ok":true,"data":{{"scanned":{},"chains":{}}}}}"#, scanned, chains)
        }

        "enrich_query" => {
            let first_method = req.get("first_method").and_then(|v| v.as_str());
            // Accept null JSON values as None
            let first_method = first_method.filter(|s| !s.is_empty());
            let limit = req.get("limit").and_then(|v| v.as_u64()).unwrap_or(100) as usize;

            let ddb = data_db.lock().unwrap();
            match ddb.enrich_query_null_risks(first_method, limit) {
                Ok(rows) => {
                    let data: Vec<serde_json::Value> = rows.into_iter().map(|(file, line, chain, first, second)| {
                        serde_json::json!({
                            "file": file,
                            "line": line,
                            "chain": chain,
                            "first_method": first,
                            "second_method": second,
                        })
                    }).collect();
                    match serde_json::to_string(&data) {
                        Ok(json) => format!(r#"{{"ok":true,"data":{}}}"#, json),
                        Err(e) => format!(r#"{{"ok":false,"error":"Serialize error: {}"}}"#, e),
                    }
                }
                Err(e) => format!(r#"{{"ok":false,"error":"Query error: {}"}}"#, e),
            }
        }

        // ─── Process state commands ─────────────────────────────────
        "process_set" => {
            let name = match req.get("name").and_then(|v| v.as_str()) {
                Some(n) => n,
                None => return r#"{"ok":false,"error":"Missing 'name' field"}"#.to_string(),
            };
            let pid = match req.get("pid").and_then(|v| v.as_u64()) {
                Some(p) => p as u32,
                None => return r#"{"ok":false,"error":"Missing 'pid' field"}"#.to_string(),
            };
            let version = req.get("version").and_then(|v| v.as_str());
            let ts = req.get("timestamp").and_then(|v| v.as_i64()).unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64
            });
            let ddb = data_db.lock().unwrap();
            match ddb.process_set(name, pid, version, ts) {
                Ok(()) => r#"{"ok":true}"#.to_string(),
                Err(e) => format!(r#"{{"ok":false,"error":"process_set failed: {}"}}"#, e),
            }
        }

        "process_get" => {
            let name = match req.get("name").and_then(|v| v.as_str()) {
                Some(n) => n,
                None => return r#"{"ok":false,"error":"Missing 'name' field"}"#.to_string(),
            };
            let ddb = data_db.lock().unwrap();
            match ddb.process_get(name) {
                Some((pid, version, started_at)) => {
                    let ver_json = match &version {
                        Some(v) => format!(r#""{}""#, v),
                        None => "null".to_string(),
                    };
                    format!(
                        r#"{{"ok":true,"data":{{"pid":{},"version":{},"started_at":{}}}}}"#,
                        pid, ver_json, started_at
                    )
                }
                None => r#"{"ok":true,"data":null}"#.to_string(),
            }
        }

        "process_remove" => {
            let name = match req.get("name").and_then(|v| v.as_str()) {
                Some(n) => n,
                None => return r#"{"ok":false,"error":"Missing 'name' field"}"#.to_string(),
            };
            let ddb = data_db.lock().unwrap();
            match ddb.process_remove(name) {
                Ok(()) => r#"{"ok":true}"#.to_string(),
                Err(e) => format!(r#"{{"ok":false,"error":"process_remove failed: {}"}}"#, e),
            }
        }

        // ─── Cache state commands ─────────────────────────────────────
        "cache_set" => {
            let key = match req.get("key").and_then(|v| v.as_str()) {
                Some(k) => k,
                None => return r#"{"ok":false,"error":"Missing 'key' field"}"#.to_string(),
            };
            let value = match req.get("value").and_then(|v| v.as_str()) {
                Some(v) => v,
                None => return r#"{"ok":false,"error":"Missing 'value' field"}"#.to_string(),
            };
            let ts = req.get("timestamp").and_then(|v| v.as_i64()).unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64
            });
            let ddb = data_db.lock().unwrap();
            match ddb.cache_set(key, value, ts) {
                Ok(()) => r#"{"ok":true}"#.to_string(),
                Err(e) => format!(r#"{{"ok":false,"error":"cache_set failed: {}"}}"#, e),
            }
        }

        "cache_get" => {
            let key = match req.get("key").and_then(|v| v.as_str()) {
                Some(k) => k,
                None => return r#"{"ok":false,"error":"Missing 'key' field"}"#.to_string(),
            };
            let ddb = data_db.lock().unwrap();
            match ddb.cache_get(key) {
                Some((value, updated_at)) => {
                    // Escape the value string for JSON embedding
                    let escaped = serde_json::to_string(&value).unwrap_or_else(|_| "\"\"".to_string());
                    format!(
                        r#"{{"ok":true,"data":{{"value":{},"updated_at":{}}}}}"#,
                        escaped, updated_at
                    )
                }
                None => r#"{"ok":true,"data":null}"#.to_string(),
            }
        }

        "ast_query" => {
            let pattern_name = req.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
            let mg_root = match req.get("magento_root").and_then(|v| v.as_str()) {
                Some(r) if !r.is_empty() => r,
                _ => return r#"{"ok":false,"error":"Missing 'magento_root' field"}"#.to_string(),
            };
            let search_path = req.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            let limit = req.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;

            let query_source = match pattern_name {
                "dataobject-set-null" => include_str!("../queries/dataobject-set-null.scm"),
                "unchecked-method-chain" => include_str!("../queries/unchecked-method-chain.scm"),
                _ => return format!(
                    r#"{{"ok":false,"error":"Unknown pattern: '{}'. Available: dataobject-set-null, unchecked-method-chain"}}"#,
                    pattern_name
                ),
            };

            let root = std::path::Path::new(mg_root);
            let target = root.join(search_path);
            let glob_pattern = format!("{}/**/*.php", target.display());

            let php_files: Vec<_> = match glob::glob(&glob_pattern) {
                Ok(paths) => paths.filter_map(|p| p.ok()).collect(),
                Err(e) => return format!(r#"{{"ok":false,"error":"Glob error: {}"}}"#, e),
            };

            let mut analyzer = match magector_core::PhpAstAnalyzer::new() {
                Ok(a) => a,
                Err(e) => return format!(r#"{{"ok":false,"error":"Analyzer init error: {}"}}"#, e),
            };

            let is_setter_pattern = pattern_name == "dataobject-set-null";
            let mg_root_prefix = format!("{}/", mg_root);
            let mut all_results: Vec<serde_json::Value> = Vec::new();

            'outer: for php_file in &php_files {
                let content = match std::fs::read_to_string(php_file) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                let rel_path = php_file.to_string_lossy()
                    .strip_prefix(&mg_root_prefix)
                    .unwrap_or(&php_file.to_string_lossy())
                    .to_string();

                let matches = match analyzer.run_query(&content, query_source) {
                    Ok(m) => m,
                    Err(_) => continue,
                };

                for m in matches {
                    // Post-filter for dataobject-set-null: only setX where X starts uppercase
                    if is_setter_pattern {
                        let is_setter = m.captures.iter().any(|(name, text)| {
                            name == "method_name"
                                && text.len() > 3
                                && text.starts_with("set")
                                && text.as_bytes()[3].is_ascii_uppercase()
                        });
                        if !is_setter {
                            continue;
                        }
                    }

                    all_results.push(serde_json::json!({
                        "file": rel_path,
                        "line": m.line,
                        "endLine": m.end_line,
                        "snippet": m.snippet,
                    }));

                    if all_results.len() >= limit {
                        break 'outer;
                    }
                }
            }

            match serde_json::to_string(&all_results) {
                Ok(json) => format!(
                    r#"{{"ok":true,"data":{},"total":{},"scanned":{}}}"#,
                    json, all_results.len(), php_files.len()
                ),
                Err(e) => format!(r#"{{"ok":false,"error":"Serialize error: {}"}}"#, e),
            }
        }

        // ─── Grep: in-process text search ─────────────────────────────────
        "grep" => {
            handle_grep_command(req)
        }

        _ => format!(r#"{{"ok":false,"error":"Unknown command: {}"}}"#, command),
    }
}

/// Expand brace patterns like `*.{php,xml}` into multiple glob patterns.
/// Returns the original pattern in a vec if no braces are found.
fn expand_brace_pattern(pattern: &str) -> Vec<String> {
    if let Some(open) = pattern.find('{') {
        if let Some(close) = pattern[open..].find('}') {
            let close = open + close;
            let prefix = &pattern[..open];
            let suffix = &pattern[close + 1..];
            let alternatives = &pattern[open + 1..close];
            return alternatives
                .split(',')
                .map(|alt| format!("{}{}{}", prefix, alt.trim(), suffix))
                .collect();
        }
    }
    vec![pattern.to_string()]
}

/// Check if a filename matches an include glob pattern.
/// Supports `*` wildcards and brace expansion `*.{php,xml}`.
fn matches_include_pattern(filename: &str, include: &str) -> bool {
    let patterns = expand_brace_pattern(include);
    patterns.iter().any(|pat| glob_match_simple(filename, pat))
}

/// Simple glob matching for filenames (not paths).
/// Supports `*` (any chars) and `?` (single char).
fn glob_match_simple(text: &str, pattern: &str) -> bool {
    let mut t = text.as_bytes();
    let mut p = pattern.as_bytes();
    let mut star_p: Option<&[u8]> = None;
    let mut star_t: Option<&[u8]> = None;

    loop {
        if p.is_empty() && t.is_empty() {
            return true;
        }
        if !p.is_empty() && p[0] == b'*' {
            star_p = Some(&p[1..]);
            star_t = Some(t);
            p = &p[1..];
            continue;
        }
        if !t.is_empty() && !p.is_empty() && (p[0] == b'?' || p[0].to_ascii_lowercase() == t[0].to_ascii_lowercase()) {
            t = &t[1..];
            p = &p[1..];
            continue;
        }
        if let (Some(sp), Some(st)) = (star_p, star_t) {
            if st.is_empty() {
                return false;
            }
            p = sp;
            star_t = Some(&st[1..]);
            t = &st[1..];
            continue;
        }
        return false;
    }
}

/// Handle the "grep" serve command: in-process text search using regex + walkdir.
fn handle_grep_command(req: &serde_json::Value) -> String {
    use walkdir::WalkDir;

    let pattern_str = match req.get("pattern").and_then(|v| v.as_str()) {
        Some(p) if !p.is_empty() => p,
        _ => return r#"{"ok":false,"error":"Missing or empty 'pattern' field"}"#.to_string(),
    };
    let mg_root = match req.get("magento_root").and_then(|v| v.as_str()) {
        Some(r) if !r.is_empty() => r,
        _ => return r#"{"ok":false,"error":"Missing 'magento_root' field"}"#.to_string(),
    };
    let search_path = req.get("path").and_then(|v| v.as_str()).unwrap_or(".");
    let include = req.get("include").and_then(|v| v.as_str()).unwrap_or("*.php");
    let context_lines = req.get("context").and_then(|v| v.as_u64()).unwrap_or(4) as usize;
    let max_results = {
        let mr = req.get("max_results").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
        mr.min(200)
    };
    let files_only = req.get("files_only").and_then(|v| v.as_bool()).unwrap_or(false);
    let ignore_case = req.get("ignore_case").and_then(|v| v.as_bool()).unwrap_or(false);

    // Build regex
    let regex_pattern = if ignore_case {
        format!("(?i){}", pattern_str)
    } else {
        pattern_str.to_string()
    };
    let re = match regex::Regex::new(&regex_pattern) {
        Ok(r) => r,
        Err(e) => {
            let err_msg = format!("Invalid regex pattern: {}", e);
            let escaped = serde_json::to_string(&err_msg).unwrap_or_else(|_| "\"regex error\"".to_string());
            return format!(r#"{{"ok":false,"error":{}}}"#, escaped);
        }
    };

    let root = std::path::Path::new(mg_root);
    let target = root.join(search_path);
    if !target.exists() {
        return format!(
            r#"{{"ok":false,"error":"Search path does not exist: {}"}}"#,
            target.display()
        );
    }

    let mg_root_prefix = format!("{}/", mg_root);
    let mut matches_output: Vec<serde_json::Value> = Vec::new();
    let mut matched_files: Vec<String> = Vec::new();
    let mut hit_limit = false;

    'file_walk: for entry in WalkDir::new(&target)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let file_path = entry.path();
        let file_name = match file_path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n,
            None => continue,
        };

        // Filter by include pattern
        if !matches_include_pattern(file_name, include) {
            continue;
        }

        // Read file content
        let content = match std::fs::read_to_string(file_path) {
            Ok(c) => c,
            Err(_) => continue, // Skip binary / unreadable files
        };

        let lines: Vec<&str> = content.lines().collect();
        let mut file_has_match = false;

        // Find all matching line numbers first
        let mut match_line_indices: Vec<usize> = Vec::new();
        for (i, line) in lines.iter().enumerate() {
            if re.is_match(line) {
                match_line_indices.push(i);
            }
        }

        if match_line_indices.is_empty() {
            continue;
        }

        // Relative path for output
        let rel_path = file_path
            .to_string_lossy()
            .strip_prefix(&mg_root_prefix)
            .unwrap_or(&file_path.to_string_lossy())
            .to_string();

        if files_only {
            matched_files.push(rel_path);
            if matched_files.len() >= max_results {
                break 'file_walk;
            }
            continue;
        }

        // Build context ranges for each match, merging overlaps
        let mut ranges: Vec<(usize, usize)> = Vec::new();
        for &idx in &match_line_indices {
            let start = idx.saturating_sub(context_lines);
            let end = (idx + context_lines).min(lines.len().saturating_sub(1));
            if let Some(last) = ranges.last_mut() {
                if start <= last.1 + 1 {
                    // Merge overlapping ranges
                    last.1 = end;
                    continue;
                }
            }
            ranges.push((start, end));
        }

        let match_set: std::collections::HashSet<usize> =
            match_line_indices.iter().copied().collect();

        for (range_start, range_end) in &ranges {
            for i in *range_start..=*range_end {
                let is_match_line = match_set.contains(&i);
                matches_output.push(serde_json::json!({
                    "file": rel_path,
                    "line": i + 1,
                    "text": lines[i],
                    "is_context": !is_match_line,
                }));
                if !file_has_match && is_match_line {
                    file_has_match = true;
                }
                if matches_output.len() >= max_results {
                    hit_limit = true;
                    break 'file_walk;
                }
            }
        }
    }

    if files_only {
        let total = matched_files.len();
        match serde_json::to_string(&matched_files) {
            Ok(json) => format!(
                r#"{{"ok":true,"data":{{"files":{},"total":{}}}}}"#,
                json, total
            ),
            Err(e) => format!(r#"{{"ok":false,"error":"Serialize error: {}"}}"#, e),
        }
    } else {
        let total = matches_output.len();
        match serde_json::to_string(&matches_output) {
            Ok(json) => format!(
                r#"{{"ok":true,"data":{{"matches":{},"total":{},"truncated":{}}}}}"#,
                json, total, hit_limit
            ),
            Err(e) => format!(r#"{{"ok":false,"error":"Serialize error: {}"}}"#, e),
        }
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

#[cfg(test)]
mod grep_tests {
    use super::*;
    use tempfile::TempDir;
    use std::fs;

    /// Create a temp directory with test PHP and XML files.
    fn setup_test_dir() -> TempDir {
        let dir = TempDir::new().unwrap();
        let root = dir.path();

        // Create vendor/module/ structure
        let module_dir = root.join("vendor").join("acme").join("module-cart");
        fs::create_dir_all(&module_dir).unwrap();

        fs::write(
            module_dir.join("Cart.php"),
            r#"<?php
namespace Acme\Cart;

class Cart
{
    public function setCouponCode($code)
    {
        $this->couponCode = $code;
        return $this;
    }

    public function getCouponCode()
    {
        return $this->couponCode;
    }

    public function clearCart()
    {
        $this->setCouponCode(null);
    }
}
"#,
        )
        .unwrap();

        fs::write(
            module_dir.join("Helper.php"),
            r#"<?php
namespace Acme\Cart;

class Helper
{
    public function applyCoupon($cart, $code)
    {
        $cart->setCouponCode($code);
    }
}
"#,
        )
        .unwrap();

        fs::write(
            module_dir.join("config.xml"),
            r#"<?xml version="1.0"?>
<config>
    <module name="Acme_Cart" />
    <setCouponCode enabled="true" />
</config>
"#,
        )
        .unwrap();

        // A file that won't match the default *.php include
        fs::write(
            module_dir.join("readme.txt"),
            "This file mentions setCouponCode but is a txt file.\n",
        )
        .unwrap();

        dir
    }

    fn make_grep_request(dir: &TempDir, overrides: serde_json::Value) -> serde_json::Value {
        let mut req = serde_json::json!({
            "command": "grep",
            "pattern": "setCouponCode",
            "magento_root": dir.path().to_string_lossy(),
            "path": "vendor/acme/module-cart",
            "include": "*.php",
            "context": 2,
            "max_results": 50,
            "files_only": false,
            "ignore_case": false,
        });
        if let serde_json::Value::Object(map) = overrides {
            for (k, v) in map {
                req[k] = v;
            }
        }
        req
    }

    #[test]
    fn test_grep_basic_match() {
        let dir = setup_test_dir();
        let req = make_grep_request(&dir, serde_json::json!({}));
        let response_str = handle_grep_command(&req);
        let resp: serde_json::Value = serde_json::from_str(&response_str).unwrap();

        assert_eq!(resp["ok"], true, "Response: {}", response_str);
        let matches = resp["data"]["matches"].as_array().unwrap();
        assert!(!matches.is_empty(), "Should find matches for setCouponCode");

        // Should find matches in both Cart.php and Helper.php
        let files: std::collections::HashSet<&str> = matches
            .iter()
            .filter(|m| m["is_context"] == false)
            .filter_map(|m| m["file"].as_str())
            .collect();
        assert!(
            files.iter().any(|f| f.contains("Cart.php")),
            "Should match in Cart.php"
        );
        assert!(
            files.iter().any(|f| f.contains("Helper.php")),
            "Should match in Helper.php"
        );
    }

    #[test]
    fn test_grep_context_lines() {
        let dir = setup_test_dir();
        let req = make_grep_request(&dir, serde_json::json!({"context": 1}));
        let response_str = handle_grep_command(&req);
        let resp: serde_json::Value = serde_json::from_str(&response_str).unwrap();

        assert_eq!(resp["ok"], true);
        let matches = resp["data"]["matches"].as_array().unwrap();

        // Should have both context (is_context=true) and match (is_context=false) lines
        let has_context = matches.iter().any(|m| m["is_context"] == true);
        let has_match = matches.iter().any(|m| m["is_context"] == false);
        assert!(has_context, "Should have context lines");
        assert!(has_match, "Should have match lines");
    }

    #[test]
    fn test_grep_files_only() {
        let dir = setup_test_dir();
        let req = make_grep_request(&dir, serde_json::json!({"files_only": true}));
        let response_str = handle_grep_command(&req);
        let resp: serde_json::Value = serde_json::from_str(&response_str).unwrap();

        assert_eq!(resp["ok"], true);
        let files = resp["data"]["files"].as_array().unwrap();
        assert_eq!(files.len(), 2, "Should find 2 PHP files with setCouponCode");

        // Should not contain config.xml (include is *.php)
        for f in files {
            assert!(
                f.as_str().unwrap().ends_with(".php"),
                "files_only should only return PHP files"
            );
        }
    }

    #[test]
    fn test_grep_include_filter_xml() {
        let dir = setup_test_dir();
        let req = make_grep_request(&dir, serde_json::json!({"include": "*.xml"}));
        let response_str = handle_grep_command(&req);
        let resp: serde_json::Value = serde_json::from_str(&response_str).unwrap();

        assert_eq!(resp["ok"], true);
        let matches = resp["data"]["matches"].as_array().unwrap();
        // Should only find matches in config.xml
        let files: std::collections::HashSet<&str> = matches
            .iter()
            .filter(|m| m["is_context"] == false)
            .filter_map(|m| m["file"].as_str())
            .collect();
        assert_eq!(files.len(), 1, "Should match only config.xml");
        assert!(
            files.iter().next().unwrap().contains("config.xml"),
            "Should be config.xml"
        );
    }

    #[test]
    fn test_grep_include_brace_expansion() {
        let dir = setup_test_dir();
        let req = make_grep_request(
            &dir,
            serde_json::json!({"include": "*.{php,xml}", "files_only": true}),
        );
        let response_str = handle_grep_command(&req);
        let resp: serde_json::Value = serde_json::from_str(&response_str).unwrap();

        assert_eq!(resp["ok"], true);
        let files = resp["data"]["files"].as_array().unwrap();
        // Should find both PHP files and XML file
        assert_eq!(files.len(), 3, "Should find 3 files (2 PHP + 1 XML)");
    }

    #[test]
    fn test_grep_ignore_case() {
        let dir = setup_test_dir();
        let req = make_grep_request(
            &dir,
            serde_json::json!({"pattern": "setcouponcode", "ignore_case": true, "files_only": true}),
        );
        let response_str = handle_grep_command(&req);
        let resp: serde_json::Value = serde_json::from_str(&response_str).unwrap();

        assert_eq!(resp["ok"], true);
        let files = resp["data"]["files"].as_array().unwrap();
        assert!(
            files.len() >= 2,
            "Case-insensitive search should still find matches"
        );
    }

    #[test]
    fn test_grep_max_results_limit() {
        let dir = setup_test_dir();
        let req = make_grep_request(
            &dir,
            serde_json::json!({"max_results": 3, "context": 0}),
        );
        let response_str = handle_grep_command(&req);
        let resp: serde_json::Value = serde_json::from_str(&response_str).unwrap();

        assert_eq!(resp["ok"], true);
        let matches = resp["data"]["matches"].as_array().unwrap();
        assert!(
            matches.len() <= 3,
            "Should respect max_results limit"
        );
    }

    #[test]
    fn test_grep_no_matches() {
        let dir = setup_test_dir();
        let req = make_grep_request(
            &dir,
            serde_json::json!({"pattern": "thisWillNeverMatchAnything12345"}),
        );
        let response_str = handle_grep_command(&req);
        let resp: serde_json::Value = serde_json::from_str(&response_str).unwrap();

        assert_eq!(resp["ok"], true);
        let matches = resp["data"]["matches"].as_array().unwrap();
        assert!(matches.is_empty(), "Should have no matches");
    }

    #[test]
    fn test_grep_missing_pattern() {
        let req = serde_json::json!({"command": "grep", "magento_root": "/tmp"});
        let response_str = handle_grep_command(&req);
        let resp: serde_json::Value = serde_json::from_str(&response_str).unwrap();
        assert_eq!(resp["ok"], false);
        assert!(resp["error"].as_str().unwrap().contains("pattern"));
    }

    #[test]
    fn test_grep_missing_magento_root() {
        let req = serde_json::json!({"command": "grep", "pattern": "test"});
        let response_str = handle_grep_command(&req);
        let resp: serde_json::Value = serde_json::from_str(&response_str).unwrap();
        assert_eq!(resp["ok"], false);
        assert!(resp["error"].as_str().unwrap().contains("magento_root"));
    }

    #[test]
    fn test_grep_invalid_regex() {
        let req = serde_json::json!({
            "command": "grep",
            "pattern": "[invalid(regex",
            "magento_root": "/tmp",
        });
        let response_str = handle_grep_command(&req);
        let resp: serde_json::Value = serde_json::from_str(&response_str).unwrap();
        assert_eq!(resp["ok"], false);
        assert!(resp["error"].as_str().unwrap().contains("regex"));
    }

    #[test]
    fn test_grep_txt_excluded_by_default() {
        let dir = setup_test_dir();
        let req = make_grep_request(
            &dir,
            serde_json::json!({"files_only": true}),
        );
        let response_str = handle_grep_command(&req);
        let resp: serde_json::Value = serde_json::from_str(&response_str).unwrap();

        assert_eq!(resp["ok"], true);
        let files = resp["data"]["files"].as_array().unwrap();
        for f in files {
            assert!(
                !f.as_str().unwrap().ends_with(".txt"),
                "txt files should not match with default *.php include"
            );
        }
    }

    // Helper function tests
    #[test]
    fn test_expand_brace_pattern() {
        assert_eq!(
            expand_brace_pattern("*.{php,xml}"),
            vec!["*.php", "*.xml"]
        );
        assert_eq!(
            expand_brace_pattern("*.{php,xml,phtml}"),
            vec!["*.php", "*.xml", "*.phtml"]
        );
        assert_eq!(
            expand_brace_pattern("*.php"),
            vec!["*.php"]
        );
    }

    #[test]
    fn test_glob_match_simple() {
        assert!(glob_match_simple("Cart.php", "*.php"));
        assert!(!glob_match_simple("Cart.php", "*.xml"));
        assert!(glob_match_simple("Cart.php", "Cart.*"));
        assert!(glob_match_simple("Cart.php", "C*.php"));
        assert!(glob_match_simple("a.b.c", "*.b.*"));
        assert!(glob_match_simple("test", "????"));
        assert!(!glob_match_simple("test", "???"));
    }
}
