//! Magento code indexer - orchestrates file discovery, parsing, and embedding

use anyhow::{Context, Result};
use indicatif::{ProgressBar, ProgressStyle};
use rayon::prelude::*;
use std::cell::RefCell;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use walkdir::WalkDir;

use crate::ast::{PhpAstAnalyzer, JsAstAnalyzer, PhpAstMetadata, JsAstMetadata};
use crate::embedder::Embedder;
use crate::magento::{
    detect_area, detect_file_type, extract_module_info, split_camel_case,
    XmlAnalyzer,
};
use crate::vectordb::{IndexMetadata, VectorDB};

/// File patterns to index
pub(crate) const INCLUDE_EXTENSIONS: &[&str] = &["php", "xml", "phtml", "js", "graphqls"];

/// Directories to always skip (matched against directory name, not path)
pub(crate) const EXCLUDE_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "var",
    "generated",
    "Test",
    "Tests",
    "test",
    "tests",
    "_files",
    "fixtures",
    "performance-toolkit",
];

/// Additional directories to skip by relative path prefix.
/// These handle cases where the directory name alone is too generic (e.g., "static").
pub(crate) const EXCLUDE_PATHS: &[&str] = &[
    "vendor/bin",
    "pub/static",
    "dev/tests",
    "dev/tools",
];

/// Maximum file size to index (100KB)
pub(crate) const MAX_FILE_SIZE: u64 = 100_000;

/// Indexing statistics
#[derive(Debug, Default)]
pub struct IndexStats {
    pub files_found: usize,
    pub files_indexed: usize,
    pub files_skipped: usize,
    pub vectors_created: usize,
    pub errors: usize,
    pub php_files: usize,
    pub js_files: usize,
    pub xml_files: usize,
    pub other_files: usize,
}

/// Intermediate result from parsing (before embedding)
pub(crate) struct ParsedFile {
    embed_text: String,
    metadata: IndexMetadata,
}

/// Embedding batch size — balance between ONNX throughput and memory
const EMBED_BATCH_SIZE: usize = 32;

// Thread-local AST analyzers (avoids mutex contention in parallel parsing)
thread_local! {
    static TL_PHP_ANALYZER: RefCell<Option<PhpAstAnalyzer>> = RefCell::new(PhpAstAnalyzer::new().ok());
    static TL_JS_ANALYZER: RefCell<Option<JsAstAnalyzer>> = RefCell::new(JsAstAnalyzer::new().ok());
}

/// Whether AST analyzers are available (checked once at init)
struct AstAvailability {
    php: bool,
    js: bool,
}

/// Main indexer
pub struct Indexer {
    embedder: Embedder,
    vectordb: VectorDB,
    xml_analyzer: XmlAnalyzer,
    magento_root: PathBuf,
    ast_available: AstAvailability,
    pub sona: Option<crate::sona::SonaEngine>,
    pub db_path: Option<PathBuf>,
    descriptions_db: Option<PathBuf>,
    /// Custom ignore patterns loaded from .magectorignore
    ignore_patterns: Vec<String>,
}

impl Indexer {
    /// Create new indexer
    pub fn new(magento_root: &Path, model_cache_dir: &Path, db_path: &Path) -> Result<Self> {
        tracing::info!("Initializing embedder...");
        let embedder = Embedder::from_pretrained(model_cache_dir)?;

        tracing::info!("Opening vector database...");
        let vectordb = VectorDB::open(db_path)?;

        // Check AST analyzer availability (thread-local instances created per-thread)
        let php_ok = PhpAstAnalyzer::new().is_ok();
        let js_ok = JsAstAnalyzer::new().is_ok();
        if php_ok && js_ok {
            tracing::info!("AST analyzers available (PHP + JavaScript, thread-local)");
        } else {
            if !php_ok { tracing::warn!("PHP AST analyzer not available"); }
            if !js_ok { tracing::warn!("JS AST analyzer not available"); }
        }

        let sona = {
            let sona_path = db_path.with_extension("sona");
            crate::sona::SonaEngine::open(&sona_path).ok()
        };

        // Load .magectorignore patterns
        let ignore_patterns = Self::load_ignore_file(magento_root);

        Ok(Self {
            embedder,
            vectordb,
            xml_analyzer: XmlAnalyzer::new(),
            magento_root: magento_root.to_path_buf(),
            ast_available: AstAvailability { php: php_ok, js: js_ok },
            sona: sona.or_else(|| Some(crate::sona::SonaEngine::new())),
            db_path: Some(db_path.to_path_buf()),
            descriptions_db: None,
            ignore_patterns,
        })
    }

    /// Set the descriptions database path for embedding enrichment.
    pub fn set_descriptions_db(&mut self, path: PathBuf) {
        self.descriptions_db = Some(path);
    }

    /// Index the Magento codebase
    pub fn index(&mut self) -> Result<IndexStats> {
        let mut stats = IndexStats::default();

        println!();
        println!("  __  __    _    ____ _____ ____ _____ ___  ____  ");
        println!(" |  \\/  |  / \\  / ___| ____/ ___|_   _/ _ \\|  _ \\ ");
        println!(" | |\\/| | / _ \\| |  _|  _|| |     | || | | | |_) |");
        println!(" | |  | |/ ___ \\ |_| | |__| |___  | || |_| |  _ < ");
        println!(" |_|  |_/_/   \\_\\____|_____\\____| |_| \\___/|_| \\_\\");
        println!();
        println!("  Semantic code search for Magento 2");
        println!();

        println!("📁 Source: {:?}", self.magento_root);
        if !self.ignore_patterns.is_empty() {
            println!("📋 .magectorignore: {} custom patterns loaded", self.ignore_patterns.len());
        }
        println!("🔍 Discovering files...");

        let files = self.discover_files()?;
        stats.files_found = files.len();

        println!("✓ Found {} files to index\n", files.len());

        // Show file type breakdown
        let mut php_files = 0;
        let mut js_files = 0;
        let mut xml_files = 0;
        let mut other_files = 0;
        for f in &files {
            match f.extension().and_then(|e| e.to_str()).unwrap_or("") {
                "php" | "phtml" => php_files += 1,
                "js" => js_files += 1,
                "xml" => xml_files += 1,
                _ => other_files += 1,
            }
        }
        println!("File breakdown:");
        println!("  PHP/PHTML: {} files", php_files);
        println!("  JavaScript: {} files", js_files);
        println!("  XML: {} files", xml_files);
        println!("  Other: {} files\n", other_files);

        // Clear existing data
        self.vectordb.clear();

        // Phase 1: Parse files in parallel (no embedding needed)
        println!("════════════════════════════════════════════════════════════");
        println!("PHASE 1: Parsing files with AST analyzers");
        println!("════════════════════════════════════════════════════════════\n");

        let pb = ProgressBar::new(files.len() as u64);
        pb.set_style(
            ProgressStyle::default_bar()
                .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {pos}/{len} ({percent}%) ~{eta} remaining")
                .unwrap()
                .progress_chars("█▓░"),
        );
        pb.enable_steady_tick(std::time::Duration::from_millis(100));

        let indexed = AtomicUsize::new(0);
        let skipped = AtomicUsize::new(0);
        let errors = AtomicUsize::new(0);
        let php_count = AtomicUsize::new(0);
        let js_count = AtomicUsize::new(0);
        let xml_count = AtomicUsize::new(0);
        let other_count = AtomicUsize::new(0);

        // Clone refs needed for parallel processing
        let magento_root = self.magento_root.clone();
        let xml_analyzer = &self.xml_analyzer;
        let ast_php = self.ast_available.php;
        let ast_js = self.ast_available.js;

        let parsed_results: Vec<_> = files
            .par_iter()
            .filter_map(|file_path| {
                pb.inc(1);

                let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
                match ext {
                    "php" | "phtml" => php_count.fetch_add(1, Ordering::Relaxed),
                    "js" => js_count.fetch_add(1, Ordering::Relaxed),
                    "xml" => xml_count.fetch_add(1, Ordering::Relaxed),
                    _ => other_count.fetch_add(1, Ordering::Relaxed),
                };

                match Self::parse_file(file_path, &magento_root, xml_analyzer, ast_php, ast_js) {
                    Ok(Some(items)) => {
                        indexed.fetch_add(1, Ordering::Relaxed);
                        Some(items)
                    }
                    Ok(None) => {
                        skipped.fetch_add(1, Ordering::Relaxed);
                        None
                    }
                    Err(e) => {
                        tracing::debug!("Error processing {:?}: {}", file_path, e);
                        errors.fetch_add(1, Ordering::Relaxed);
                        None
                    }
                }
            })
            .flatten()
            .collect();

        pb.finish_with_message("✓ Parsing complete");

        stats.files_indexed = indexed.load(Ordering::Relaxed);
        stats.files_skipped = skipped.load(Ordering::Relaxed);
        stats.errors = errors.load(Ordering::Relaxed);
        stats.php_files = php_count.load(Ordering::Relaxed);
        stats.js_files = js_count.load(Ordering::Relaxed);
        stats.xml_files = xml_count.load(Ordering::Relaxed);
        stats.other_files = other_count.load(Ordering::Relaxed);

        println!("\n✓ Parsing complete:");
        println!("  Files parsed: {}", stats.files_indexed);
        println!("  Files skipped: {}", stats.files_skipped);
        println!("  Errors: {}", stats.errors);
        println!("  Items to embed: {}\n", parsed_results.len());

        // Inject LLM descriptions into embedding text (prepend before raw content)
        let mut parsed_results = parsed_results;
        if let Some(ref desc_db_path) = self.descriptions_db {
            if desc_db_path.exists() {
                match crate::describe::DescriptionDb::open_readonly(desc_db_path) {
                    Ok(desc_db) => {
                        let mut enriched = 0usize;
                        for item in &mut parsed_results {
                            if let Some(desc) = desc_db.get(&item.metadata.path) {
                                // Prepend description to embed_text
                                let prefix = format!("Description: {}\n\n", desc.description);
                                item.embed_text.insert_str(0, &prefix);
                                enriched += 1;
                            }
                        }
                        if enriched > 0 {
                            println!("✓ Enriched {} items with LLM descriptions\n", enriched);
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Could not open descriptions DB: {}", e);
                    }
                }
            }
        }

        // Phase 2: Generate embeddings in batches
        println!("════════════════════════════════════════════════════════════");
        println!("PHASE 2: Generating semantic embeddings (ONNX, batch={})", EMBED_BATCH_SIZE);
        println!("════════════════════════════════════════════════════════════\n");

        // Pre-allocate vectordb with known capacity
        self.vectordb = VectorDB::with_capacity(parsed_results.len());

        let total_items = parsed_results.len();
        let pb = ProgressBar::new(total_items as u64);
        pb.set_style(
            ProgressStyle::default_bar()
                .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {pos}/{len} ({percent}%) ~{eta} remaining")
                .unwrap()
                .progress_chars("█▓░"),
        );
        pb.enable_steady_tick(std::time::Duration::from_millis(100));

        let mut embedded = 0;

        // Process in batches
        for chunk in parsed_results.chunks(EMBED_BATCH_SIZE) {
            let texts: Vec<&str> = chunk.iter().map(|p| p.embed_text.as_str()).collect();

            let embeddings = self.embedder.embed_batch(&texts)?;

            let batch_items: Vec<(Vec<f32>, IndexMetadata)> = embeddings
                .into_iter()
                .zip(chunk.iter())
                .map(|(emb, parsed)| (emb, parsed.metadata.clone()))
                .collect();

            let batch_len = batch_items.len();
            self.vectordb.insert_batch(batch_items);

            embedded += batch_len;
            pb.inc(batch_len as u64);
            pb.set_message(format!("Embedded {} vectors", embedded));
        }

        pb.finish_with_message(format!("✓ Generated {} embeddings", embedded));

        stats.vectors_created = self.vectordb.len();

        println!("\n════════════════════════════════════════════════════════════");
        println!("                    INDEXING COMPLETE                       ");
        println!("════════════════════════════════════════════════════════════\n");

        Ok(stats)
    }

    /// Discover files to index (no symlink following for speed)
    pub(crate) fn discover_files(&self) -> Result<Vec<PathBuf>> {
        let mut files = Vec::new();
        let root = &self.magento_root;
        let ignore = &self.ignore_patterns;

        for entry in WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| !Self::should_skip_entry(e, root, ignore))
        {
            let entry = entry?;
            if entry.file_type().is_file() {
                let path = entry.path();

                // Check extension first (cheap), then file size
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if INCLUDE_EXTENSIONS.contains(&ext) {
                        // Use entry metadata (already cached from DirEntry)
                        if let Ok(meta) = entry.metadata() {
                            if meta.len() <= MAX_FILE_SIZE {
                                files.push(path.to_path_buf());
                            }
                        }
                    }
                }
            }
        }

        Ok(files)
    }

    /// Check if a directory entry should be skipped during traversal.
    ///
    /// Checks (in order, cheapest first):
    /// 1. Directory name against EXCLUDE_DIRS (O(1) per entry)
    /// 2. Relative path prefix against EXCLUDE_PATHS (for nested paths like pub/static)
    /// 3. .magectorignore patterns (directory prefix matching)
    pub(crate) fn should_skip_entry(
        entry: &walkdir::DirEntry,
        root: &Path,
        ignore_patterns: &[String],
    ) -> bool {
        if !entry.file_type().is_dir() {
            return false;
        }

        let name = entry.file_name().to_string_lossy();

        // 1. Fast: exact directory name match
        if EXCLUDE_DIRS.iter().any(|&d| name == *d) {
            return true;
        }

        // 2. Relative path prefix match (for paths like pub/static, dev/tools)
        if let Ok(relative) = entry.path().strip_prefix(root) {
            let rel_str = relative.to_string_lossy();

            // Check built-in path exclusions
            if EXCLUDE_PATHS.iter().any(|&p| rel_str == p || rel_str.starts_with(&format!("{}/", p))) {
                return true;
            }

            // 3. .magectorignore patterns (directory prefix matching)
            if !ignore_patterns.is_empty() {
                for pattern in ignore_patterns {
                    let trimmed = pattern.trim_end_matches('/');
                    // Exact match: "some/dir" matches "some/dir"
                    // Prefix match: "some/dir" matches "some/dir/subdir"
                    // Name match: "dirname" matches any directory with that name
                    if rel_str == trimmed
                        || rel_str.starts_with(&format!("{}/", trimmed))
                        || (!trimmed.contains('/') && name == *trimmed)
                    {
                        return true;
                    }
                }
            }
        }

        false
    }

    /// Backwards-compatible check for external callers (watcher.rs).
    /// Uses only built-in exclusions, no .magectorignore patterns.
    pub(crate) fn should_skip_dir(entry: &walkdir::DirEntry) -> bool {
        if entry.file_type().is_dir() {
            let name = entry.file_name().to_string_lossy();
            return EXCLUDE_DIRS.iter().any(|&d| name == *d);
        }
        false
    }

    /// Load .magectorignore file from the project root.
    /// Returns a list of directory patterns to exclude.
    ///
    /// Format (one pattern per line, similar to .gitignore):
    ///   - Lines starting with # are comments
    ///   - Empty lines are ignored
    ///   - Trailing slashes are stripped
    ///   - Patterns without / match directory names anywhere
    ///   - Patterns with / match relative paths from project root
    fn load_ignore_file(root: &Path) -> Vec<String> {
        let ignore_path = root.join(".magectorignore");
        match fs::read_to_string(&ignore_path) {
            Ok(content) => {
                let patterns: Vec<String> = content
                    .lines()
                    .map(|line| line.trim())
                    .filter(|line| !line.is_empty() && !line.starts_with('#'))
                    .map(|line| line.trim_end_matches('/').to_string())
                    .collect();
                if !patterns.is_empty() {
                    tracing::info!(
                        "Loaded {} patterns from .magectorignore",
                        patterns.len()
                    );
                }
                patterns
            }
            Err(_) => Vec::new(),
        }
    }

    /// Parse a single file (no embedding, can be parallelized with thread-local AST)
    pub(crate) fn parse_file(
        path: &Path,
        magento_root: &Path,
        xml_analyzer: &XmlAnalyzer,
        ast_php: bool,
        ast_js: bool,
    ) -> Result<Option<Vec<ParsedFile>>> {
        let content = fs::read_to_string(path).context("Failed to read file")?;

        if content.is_empty() {
            return Ok(None);
        }

        let relative_path = path
            .strip_prefix(magento_root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");

        let file_type = match ext {
            "php" => "php",
            "xml" => "xml",
            "phtml" => "template",
            "js" => "javascript",
            "graphqls" => "graphql",
            _ => "other",
        };

        let magento_type = detect_file_type(&relative_path);
        let module_info = extract_module_info(&relative_path);
        let area = detect_area(&relative_path);

        // Parse with thread-local AST analyzers (no mutex contention)
        let (php_ast, js_ast, xml_meta) = match ext {
            "php" | "phtml" if ast_php => {
                let php_meta = TL_PHP_ANALYZER.with(|cell| {
                    let mut opt = cell.borrow_mut();
                    opt.as_mut().map(|analyzer| analyzer.analyze(&content))
                });
                (php_meta, None, None)
            }
            "js" if ast_js => {
                let js_meta = TL_JS_ANALYZER.with(|cell| {
                    let mut opt = cell.borrow_mut();
                    opt.as_mut().map(|analyzer| analyzer.analyze(&content))
                });
                (None, js_meta, None)
            }
            "xml" => (None, None, Some(xml_analyzer.analyze(&content))),
            _ => (None, None, None),
        };

        // Generate search text
        let search_text = Self::generate_search_text_from_ast(
            &content,
            &relative_path,
            php_ast.as_ref(),
            js_ast.as_ref(),
            xml_meta.as_ref(),
        );

        // Create embedding text (description injected later in index/index_files)
        let embed_text = Self::create_embedding_text(
            &content,
            &relative_path,
            php_ast.as_ref(),
            js_ast.as_ref(),
            &search_text,
            None,
        );

        // Build metadata
        let metadata = Self::build_metadata(
            relative_path,
            file_type,
            magento_type,
            module_info,
            area,
            php_ast,
            js_ast,
            search_text,
        );

        Ok(Some(vec![ParsedFile { embed_text, metadata }]))
    }

    fn generate_search_text_from_ast(
        content: &str,
        path: &str,
        php_ast: Option<&PhpAstMetadata>,
        js_ast: Option<&JsAstMetadata>,
        xml_meta: Option<&crate::magento::XmlMetadata>,
    ) -> String {
        let mut terms = Vec::new();
        let path_lower = path.to_lowercase();

        // PHP AST terms
        if let Some(php) = php_ast {
            if let Some(ref class) = php.class_name {
                terms.push(class.clone());
                terms.push(split_camel_case(class));
            }
            if let Some(ref ns) = php.namespace {
                terms.push(ns.replace("\\", " "));
            }
            for method in &php.methods {
                terms.push(method.name.clone());
                terms.push(split_camel_case(&method.name));
            }
            if php.is_controller {
                // Add strong controller signals
                terms.push("controller action execute http request response".to_string());
                terms.push("controller controller controller".to_string()); // Weight boost
            }
            if php.is_repository {
                terms.push("repository data persistence save load get delete getList getById".to_string());
                terms.push("repository repository repository interface".to_string()); // Weight boost
            }
            if php.is_plugin {
                terms.push("plugin interceptor before after around".to_string());
                terms.push("plugin plugin plugin".to_string()); // Weight boost
                for pm in &php.plugin_methods {
                    terms.push(format!("{} {}", pm.method_type, pm.target_method));
                }
            }
            if php.is_observer {
                terms.push("observer event listener dispatch".to_string());
            }
            if php.is_model {
                terms.push("model entity data resource collection".to_string());
            }
            if php.is_block {
                terms.push("block template view render toHtml".to_string());
            }
            if php.is_resolver {
                terms.push("graphql resolver query mutation field".to_string());
            }
            if php.is_helper {
                terms.push("helper utility data helper helper helper".to_string()); // Weight boost
                terms.push("helper class data output".to_string());
            }
            if php.is_setup {
                terms.push("setup install schema data patch upgrade".to_string());
                terms.push("setup setup setup".to_string()); // Weight boost
            }
        }

        // Path-based fallbacks (ensure detection even if AST misses it)
        if path_lower.contains("/controller/") {
            terms.push("controller action execute http request".to_string());
            terms.push("controller controller controller".to_string());
        }
        if path_lower.contains("/helper/") {
            terms.push("helper utility data helper helper helper".to_string());
            terms.push("helper class data output abstract".to_string());
        }
        if path_lower.contains("/plugin/") {
            terms.push("plugin interceptor before after around".to_string());
            terms.push("plugin plugin plugin".to_string());
        }
        if path_lower.contains("/model/") && path_lower.contains("repository") {
            terms.push("repository data persistence save load get delete getList getById".to_string());
            terms.push("repository repository repository interface".to_string());
        }
        if path_lower.contains("/setup/") || path_lower.contains("installschema")
            || path_lower.contains("installdata") || path_lower.contains("upgradeschema")
            || path_lower.contains("upgradedata") || path_lower.contains("/patch")
        {
            terms.push("setup install schema data patch upgrade".to_string());
            terms.push("setup setup setup".to_string());
        }

        // Path-based inventory detection
        if path_lower.contains("inventory") || path_lower.contains("cataloginventory") {
            terms.push("inventory stock qty source reservation".to_string());
        }

        // JS AST terms
        if let Some(js) = js_ast {
            for class in &js.classes {
                terms.push(class.name.clone());
                terms.push(split_camel_case(&class.name));
            }
            for func in &js.functions {
                terms.push(func.name.clone());
            }
            if js.is_ui_component {
                terms.push("ui component knockout observable".to_string());
            }
            if js.is_widget {
                terms.push("jquery widget $.widget".to_string());
            }
            if js.is_mixin {
                terms.push("mixin extend override requirejs".to_string());
                if let Some(ref target) = js.mixin_target {
                    terms.push(target.clone());
                }
            }
            for dep in &js.dependencies {
                terms.push(dep.clone());
            }
        }

        // XML terms - ENHANCED
        if let Some(xml) = xml_meta {
            for pref in &xml.preferences {
                terms.push(pref.0.clone());
                terms.push(pref.1.clone());
            }
            for plugin in &xml.plugins {
                terms.push(plugin.0.clone());
                terms.push(plugin.1.clone());
            }
            for event in &xml.events {
                terms.push(event.clone());
            }
        }

        // XML file-specific enrichment
        if path.ends_with(".xml") {
            let filename = path.split('/').last().unwrap_or("");

            // Add filename multiple times for weight
            terms.push(filename.to_string());
            terms.push(filename.to_string());

            match filename {
                "di.xml" => {
                    terms.push("di.xml dependency injection preference plugin type virtualType argument".to_string());
                    terms.push("di.xml di.xml di.xml di.xml configuration".to_string());
                    terms.push("dependency injection dependency injection".to_string());
                    terms.push("plugin type configuration di.xml preference".to_string());
                }
                "events.xml" => {
                    terms.push("events.xml observer event listener dispatch".to_string());
                }
                "routes.xml" => {
                    terms.push("routes.xml routing frontend adminhtml".to_string());
                }
                "webapi.xml" => {
                    terms.push("webapi.xml rest api endpoint method".to_string());
                }
                "db_schema.xml" => {
                    terms.push("db_schema.xml declarative schema table column constraint".to_string());
                    terms.push("db_schema db_schema db_schema".to_string());
                }
                "acl.xml" => {
                    terms.push("acl.xml access control permission resource".to_string());
                }
                "menu.xml" => {
                    terms.push("menu.xml admin navigation".to_string());
                }
                "system.xml" => {
                    terms.push("system.xml configuration admin settings".to_string());
                }
                "config.xml" => {
                    terms.push("config.xml default configuration values".to_string());
                }
                _ if filename.contains("layout") || path_lower.contains("/layout/") => {
                    terms.push("layout xml block handle container reference".to_string());
                    terms.push("layout layout layout".to_string());
                }
                _ if filename == "widget.xml" => {
                    terms.push("widget.xml cms widget parameter".to_string());
                }
                _ if filename == "crontab.xml" => {
                    terms.push("crontab.xml cron job schedule".to_string());
                }
                _ if filename == "email_templates.xml" => {
                    terms.push("email_templates.xml email template transactional".to_string());
                }
                _ => {}
            }

            // Extract root element from XML content
            if let Some(root_start) = content.find('<') {
                if let Some(root_end) = content[root_start..].find(|c| c == ' ' || c == '>' || c == '/') {
                    let root_tag = &content[root_start + 1..root_start + root_end];
                    if !root_tag.starts_with('?') && !root_tag.starts_with('!') {
                        terms.push(format!("xml {} configuration", root_tag));
                    }
                }
            }
        }

        // Path terms
        for part in path.split('/') {
            if part.len() > 2 {
                terms.push(part.to_string());
                // Add split version for compound names
                if part.contains('_') || part.chars().any(|c| c.is_uppercase()) {
                    terms.push(split_camel_case(part));
                }
            }
        }

        terms.join(" ")
    }

    /// Create embedding text with enrichments
    fn create_embedding_text(
        content: &str,
        path: &str,
        php_ast: Option<&PhpAstMetadata>,
        js_ast: Option<&JsAstMetadata>,
        search_text: &str,
        description: Option<&str>,
    ) -> String {
        let mut text = String::with_capacity(content.len() + 2000);

        // Prepend LLM description if available — places semantic terms within
        // the 256-token ONNX window before raw content gets truncated
        if let Some(desc) = description {
            text.push_str("Description: ");
            text.push_str(desc);
            text.push_str("\n\n");
        }

        // Add code content (truncated at char boundary)
        let content_limit = 6000;
        if content.len() > content_limit {
            // Find a valid char boundary
            let mut end = content_limit;
            while end > 0 && !content.is_char_boundary(end) {
                end -= 1;
            }
            text.push_str(&content[..end]);
        } else {
            text.push_str(content);
        }

        // PHP enrichment
        if let Some(php) = php_ast {
            if let Some(ref class) = php.class_name {
                text.push_str(&format!(" class {} {} {}", class, class, class));
            }
            if let Some(ref ns) = php.namespace {
                text.push_str(&format!(" namespace {}", ns.replace('\\', " ")));
            }
            if let Some(ref ext) = php.extends {
                text.push_str(&format!(" extends {}", ext));
            }
            for impl_name in &php.implements {
                text.push_str(&format!(" implements {}", impl_name));
            }
            // Add method names with emphasis
            for method in &php.methods {
                text.push_str(&format!(" method {}", method.name));
            }
            // Add type signals for better semantic matching
            if php.is_helper {
                text.push_str(" helper helper helper utility data");
            }
            if php.is_setup {
                text.push_str(" setup setup setup install schema patch upgrade");
            }
            if php.is_plugin {
                text.push_str(" plugin plugin interceptor before after around");
            }
            if php.is_repository {
                text.push_str(" repository repository interface persistence save load get");
            }
        }

        // JS enrichment
        if let Some(js) = js_ast {
            for class in &js.classes {
                text.push_str(&format!(" class {} {}", class.name, class.name));
            }
            for dep in &js.dependencies {
                text.push_str(&format!(" requires {}", dep));
            }
            if let Some(ref name) = js.component_name {
                text.push_str(&format!(" component {}", name));
            }
        }

        // Add path components
        for part in path.split('/') {
            if part.len() > 2 {
                text.push_str(&format!(" {}", part));
            }
        }

        // Add search text
        text.push_str(&format!(" {}", search_text));

        // Truncate if too long (at char boundary)
        if text.len() > 8000 {
            let mut end = 8000;
            while end > 0 && !text.is_char_boundary(end) {
                end -= 1;
            }
            text.truncate(end);
        }

        text
    }

    fn build_metadata(
        path: String,
        file_type: &str,
        magento_type: crate::magento::MagentoFileType,
        module_info: Option<crate::magento::ModuleInfo>,
        area: Option<String>,
        php_ast: Option<PhpAstMetadata>,
        js_ast: Option<JsAstMetadata>,
        search_text: String,
    ) -> IndexMetadata {
        // Path-based type detection for fallback
        let path_lower = path.to_lowercase();
        let path_is_plugin = path_lower.contains("/plugin/");
        let path_is_repository = path_lower.contains("/model/") && path_lower.contains("repository");
        let path_is_controller = path_lower.contains("/controller/");
        let path_is_observer = path_lower.contains("/observer/");
        let path_is_block = path_lower.contains("/block/");

        let (
            class_name,
            class_type,
            namespace,
            extends,
            implements,
            methods,
            is_controller,
            is_repository,
            is_plugin,
            is_observer,
            is_model,
            is_block,
            is_resolver,
            is_api_interface,
        ) = if let Some(php) = php_ast {
            (
                php.class_name,
                php.class_type,
                php.namespace,
                php.extends,
                php.implements,
                php.methods.iter().map(|m| m.name.clone()).collect(),
                php.is_controller || path_is_controller,
                php.is_repository || path_is_repository,
                php.is_plugin || path_is_plugin,
                php.is_observer || path_is_observer,
                php.is_model,
                php.is_block || path_is_block,
                php.is_resolver,
                php.is_api_interface,
            )
        } else {
            // No AST — fall back to path-based detection
            (None, None, None, None, Vec::new(), Vec::new(),
             path_is_controller, path_is_repository, path_is_plugin, path_is_observer,
             false, path_is_block, false, false)
        };

        let (is_ui_component, is_widget, is_mixin, js_dependencies) = if let Some(js) = js_ast {
            (
                js.is_ui_component,
                js.is_widget,
                js.is_mixin,
                js.dependencies,
            )
        } else {
            (false, false, false, Vec::new())
        };

        IndexMetadata {
            path,
            file_type: file_type.to_string(),
            magento_type: Some(magento_type.as_str().to_string()),
            class_name,
            class_type,
            method_name: methods.first().cloned(),
            methods,
            namespace,
            module: module_info.as_ref().map(|m| m.full.clone()),
            area,
            extends,
            implements,
            is_controller,
            is_repository,
            is_plugin,
            is_observer,
            is_model,
            is_block,
            is_resolver,
            is_api_interface,
            is_ui_component,
            is_widget,
            is_mixin,
            js_dependencies,
            search_text,
        }
    }

    /// Incrementally index a specific set of files.
    /// Returns a list of (relative_path, vector_ids) for manifest tracking.
    pub fn index_files(&mut self, files: &[PathBuf]) -> Result<Vec<(String, Vec<usize>)>> {
        let magento_root = self.magento_root.clone();
        let xml_analyzer = &self.xml_analyzer;
        let ast_php = self.ast_available.php;
        let ast_js = self.ast_available.js;

        // Parse files in parallel
        let mut parsed_results: Vec<_> = files
            .par_iter()
            .filter_map(|file_path| {
                match Self::parse_file(file_path, &magento_root, xml_analyzer, ast_php, ast_js) {
                    Ok(Some(items)) => Some(items),
                    _ => None,
                }
            })
            .flatten()
            .collect();

        if parsed_results.is_empty() {
            return Ok(Vec::new());
        }

        // Inject LLM descriptions into embedding text
        if let Some(ref desc_db_path) = self.descriptions_db {
            if desc_db_path.exists() {
                if let Ok(desc_db) = crate::describe::DescriptionDb::open_readonly(desc_db_path) {
                    for item in &mut parsed_results {
                        if let Some(desc) = desc_db.get(&item.metadata.path) {
                            let prefix = format!("Description: {}\n\n", desc.description);
                            item.embed_text.insert_str(0, &prefix);
                        }
                    }
                }
            }
        }

        // Embed and insert
        let mut result = Vec::new();
        for chunk in parsed_results.chunks(EMBED_BATCH_SIZE) {
            let texts: Vec<&str> = chunk.iter().map(|p| p.embed_text.as_str()).collect();
            let embeddings = self.embedder.embed_batch(&texts)?;

            for (emb, parsed) in embeddings.into_iter().zip(chunk.iter()) {
                let path = parsed.metadata.path.clone();
                let id = self.vectordb.insert(&emb, parsed.metadata.clone());
                // Group by path
                if let Some(entry) = result.iter_mut().find(|(p, _): &&mut (String, Vec<usize>)| p == &path) {
                    entry.1.push(id);
                } else {
                    result.push((path, vec![id]));
                }
            }
        }

        Ok(result)
    }

    /// Remove all vectors associated with a file path (tombstone)
    pub fn remove_vectors_for_path(&mut self, path: &str) -> Vec<usize> {
        self.vectordb.remove_by_path(path)
    }

    /// Get the tombstone ratio of the vector DB
    pub(crate) fn vectordb_tombstone_ratio(&self) -> f64 {
        self.vectordb.tombstone_ratio()
    }

    /// Compact the vector DB (rebuild HNSW, purge tombstones)
    pub(crate) fn compact_vectordb(&mut self) {
        self.vectordb.compact();
    }

    /// Save the index to disk
    pub fn save(&self, path: &Path) -> Result<()> {
        self.vectordb.save(path)
    }

    /// Embed a query string (public accessor for feedback/LoRA training)
    pub fn embed_query(&mut self, query: &str) -> Result<Vec<f32>> {
        self.embedder.embed(query)
    }

    /// Search the index (hybrid: semantic + keyword re-ranking)
    pub fn search(&mut self, query: &str, k: usize) -> Result<Vec<crate::vectordb::SearchResult>> {
        let mut query_embedding = self.embedder.embed(query)?;
        // Apply MicroLoRA adjustment before HNSW search
        if let Some(ref sona) = self.sona {
            sona.adjust_query_embedding(&mut query_embedding);
        }
        Ok(self.vectordb.hybrid_search(
            &query_embedding,
            query,
            k,
            self.sona.as_ref(),
        ))
    }

    /// Get index statistics
    pub fn stats(&self) -> IndexStats {
        IndexStats {
            vectors_created: self.vectordb.len(),
            ..Default::default()
        }
    }
}

