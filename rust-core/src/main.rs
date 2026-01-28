//! Magector CLI - Magento code indexer and search tool

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use magector_core::{Indexer, VectorDB, Embedder, Validator, EMBEDDING_DIM};

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
        #[arg(short, long, default_value = "./models")]
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
        #[arg(short, long, default_value = "./models")]
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
        #[arg(short, long, default_value = "./models")]
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
        #[arg(short, long, default_value = "./models")]
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
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    // Initialize logging
    let level = if cli.verbose { "debug" } else { "info" };
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(level))
        .with(tracing_subscriber::fmt::layer())
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
    let db_exists = database.with_extension("bin").exists()
        || database.with_extension("json").exists();

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
