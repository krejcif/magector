//! Magento code indexer - orchestrates file discovery, parsing, and embedding

use anyhow::{Context, Result};
use indicatif::{ProgressBar, ProgressStyle};
use rayon::prelude::*;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use walkdir::WalkDir;

use crate::ast::{PhpAstAnalyzer, JsAstAnalyzer, PhpAstMetadata, JsAstMetadata};
use crate::embedder::Embedder;
use crate::magento::{
    detect_area, detect_file_type, extract_module_info, split_camel_case,
    XmlAnalyzer,
};
use crate::vectordb::{IndexMetadata, VectorDB};

/// File patterns to index
const INCLUDE_EXTENSIONS: &[&str] = &["php", "xml", "phtml", "js", "graphqls"];

/// Directories to skip
const EXCLUDE_DIRS: &[&str] = &[
    "node_modules",
    "vendor/bin",
    ".git",
    "var",
    "pub/static",
    "generated",
    "dev/tests",
    "dev/tools",
    "Test",
    "Tests",
    "test",
    "tests",
    "_files",
    "fixtures",
    "performance-toolkit",
    "lib/internal",
];

/// Maximum file size to index (100KB)
const MAX_FILE_SIZE: u64 = 100_000;

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
struct ParsedFile {
    embed_text: String,
    metadata: IndexMetadata,
}

/// Thread-safe AST analyzers wrapper
struct AstAnalyzers {
    php: Mutex<PhpAstAnalyzer>,
    js: Mutex<JsAstAnalyzer>,
}

/// Main indexer
pub struct Indexer {
    embedder: Embedder,
    vectordb: VectorDB,
    xml_analyzer: XmlAnalyzer,
    magento_root: PathBuf,
    ast_analyzers: Option<AstAnalyzers>,
}

impl Indexer {
    /// Create new indexer
    pub fn new(magento_root: &Path, model_cache_dir: &Path, db_path: &Path) -> Result<Self> {
        tracing::info!("Initializing embedder...");
        let embedder = Embedder::from_pretrained(model_cache_dir)?;

        tracing::info!("Opening vector database...");
        let vectordb = VectorDB::open(db_path)?;

        // Initialize AST analyzers
        let ast_analyzers = match (PhpAstAnalyzer::new(), JsAstAnalyzer::new()) {
            (Ok(php), Ok(js)) => {
                tracing::info!("AST analyzers initialized (PHP + JavaScript)");
                Some(AstAnalyzers {
                    php: Mutex::new(php),
                    js: Mutex::new(js),
                })
            }
            (Err(e), _) => {
                tracing::warn!("Failed to initialize PHP AST analyzer: {}", e);
                None
            }
            (_, Err(e)) => {
                tracing::warn!("Failed to initialize JS AST analyzer: {}", e);
                None
            }
        };

        Ok(Self {
            embedder,
            vectordb,
            xml_analyzer: XmlAnalyzer::new(),
            magento_root: magento_root.to_path_buf(),
            ast_analyzers,
        })
    }

    /// Index the Magento codebase
    pub fn index(&mut self) -> Result<IndexStats> {
        let mut stats = IndexStats::default();

        println!("\n╔═══════════════════════════════════════════════════════════╗");
        println!("║              MAGECTOR INDEXING ENGINE                     ║");
        println!("╚═══════════════════════════════════════════════════════════╝\n");

        println!("📁 Source: {:?}", self.magento_root);
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
                .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {pos}/{len} ({percent}%) {msg}")
                .unwrap()
                .progress_chars("█▓░"),
        );
        pb.set_message("Parsing...");
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
        let ast_analyzers = &self.ast_analyzers;

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

                match Self::parse_file(file_path, &magento_root, xml_analyzer, ast_analyzers) {
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

        // Phase 2: Generate embeddings sequentially
        println!("════════════════════════════════════════════════════════════");
        println!("PHASE 2: Generating semantic embeddings (ONNX)");
        println!("════════════════════════════════════════════════════════════\n");

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
        let report_interval = (total_items / 20).max(100); // Report every 5%

        for (i, parsed) in parsed_results.into_iter().enumerate() {
            // Generate embedding
            let embedding = self.embedder.embed(&parsed.embed_text)?;

            // Insert into vector DB
            self.vectordb.insert(&embedding, parsed.metadata);
            embedded += 1;
            pb.inc(1);

            // Periodic status update
            if (i + 1) % report_interval == 0 {
                pb.set_message(format!("Embedded {} vectors", embedded));
            }
        }

        pb.finish_with_message(format!("✓ Generated {} embeddings", embedded));

        stats.vectors_created = self.vectordb.len();

        println!("\n════════════════════════════════════════════════════════════");
        println!("                    INDEXING COMPLETE                       ");
        println!("════════════════════════════════════════════════════════════\n");

        Ok(stats)
    }

    /// Discover files to index
    fn discover_files(&self) -> Result<Vec<PathBuf>> {
        let mut files = Vec::new();

        for entry in WalkDir::new(&self.magento_root)
            .follow_links(true)
            .into_iter()
            .filter_entry(|e| !Self::should_skip_dir(e))
        {
            let entry = entry?;
            if entry.file_type().is_file() {
                let path = entry.path();

                // Check extension
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if INCLUDE_EXTENSIONS.contains(&ext) {
                        // Check file size
                        if let Ok(meta) = fs::metadata(path) {
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

    /// Check if directory should be skipped
    fn should_skip_dir(entry: &walkdir::DirEntry) -> bool {
        if entry.file_type().is_dir() {
            let name = entry.file_name().to_string_lossy();
            return EXCLUDE_DIRS.iter().any(|&d| name == d);
        }
        false
    }

    /// Parse a single file (no embedding, can be parallelized)
    fn parse_file(
        path: &Path,
        magento_root: &Path,
        xml_analyzer: &XmlAnalyzer,
        ast_analyzers: &Option<AstAnalyzers>,
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

        // Parse with AST or fallback to regex
        let (php_ast, js_ast, xml_meta) = match ext {
            "php" | "phtml" => {
                let php_meta = if let Some(ref analyzers) = ast_analyzers {
                    if let Ok(mut analyzer) = analyzers.php.lock() {
                        Some(analyzer.analyze(&content))
                    } else {
                        None
                    }
                } else {
                    None
                };
                (php_meta, None, None)
            }
            "js" => {
                let js_meta = if let Some(ref analyzers) = ast_analyzers {
                    if let Ok(mut analyzer) = analyzers.js.lock() {
                        Some(analyzer.analyze(&content))
                    } else {
                        None
                    }
                } else {
                    None
                };
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

        // Create embedding text
        let embed_text = Self::create_embedding_text(
            &content,
            &relative_path,
            php_ast.as_ref(),
            js_ast.as_ref(),
            &search_text,
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
                terms.push("repository data persistence save load get".to_string());
            }
            if php.is_plugin {
                terms.push("plugin interceptor before after around".to_string());
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
        }

        // Path-based controller detection (fallback if AST doesn't catch it)
        if path_lower.contains("/controller/") {
            terms.push("controller action execute http request".to_string());
            terms.push("controller controller controller".to_string());
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
                    terms.push("di.xml dependency injection preference plugin type virtualType".to_string());
                    terms.push("di.xml di.xml di.xml configuration".to_string());
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
    ) -> String {
        let mut text = String::with_capacity(content.len() + 2000);

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
                php.is_controller,
                php.is_repository,
                php.is_plugin,
                php.is_observer,
                php.is_model,
                php.is_block,
                php.is_resolver,
                php.is_api_interface,
            )
        } else {
            (None, None, None, None, Vec::new(), Vec::new(), false, false, false, false, false, false, false, false)
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

    /// Save the index to disk
    pub fn save(&self, path: &Path) -> Result<()> {
        self.vectordb.save(path)
    }

    /// Search the index
    pub fn search(&mut self, query: &str, k: usize) -> Result<Vec<crate::vectordb::SearchResult>> {
        let query_embedding = self.embedder.embed(query)?;
        Ok(self.vectordb.search(&query_embedding, k))
    }

    /// Get index statistics
    pub fn stats(&self) -> IndexStats {
        IndexStats {
            vectors_created: self.vectordb.len(),
            ..Default::default()
        }
    }
}

