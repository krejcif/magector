# Magector

**Semantic code search engine for Magento 2, powered by ONNX embeddings and HNSW vector search.**

Magector indexes an entire Magento 2 codebase and lets you search it with natural language. Instead of grepping for keywords, ask questions like *"how are checkout totals calculated?"* or *"where is the product price determined?"* and get ranked, relevant results in under 50ms.

[![Rust](https://img.shields.io/badge/rust-1.75+-orange.svg)](https://www.rust-lang.org)
[![Node.js](https://img.shields.io/badge/node-18+-green.svg)](https://nodejs.org)
[![Magento](https://img.shields.io/badge/magento-2.4.x-blue.svg)](https://magento.com)
[![Accuracy](https://img.shields.io/badge/accuracy-94.8%25-brightgreen.svg)](#validation)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

---

## Why Magector

Magento 2 has **18,000+ source files** across hundreds of modules. Finding the right code is slow:

| Approach | Finds semantic matches | Understands Magento patterns | Speed (18K files) |
|----------|:---------------------:|:---------------------------:|:-----------------:|
| `grep` / `ripgrep` | No | No | 100-500ms |
| IDE search | No | No | 200-1000ms |
| GitHub search | Partial | No | 500-2000ms |
| **Magector** | **Yes** | **Yes** | **15-45ms** |

Magector understands that a query about *"payment capture"* should return `Sales/Model/Order/Payment/Operations/CaptureOperation.php`, not just files containing the word "capture".

---

## Features

- **Semantic search** -- find code by meaning, not exact keywords
- **94.8% accuracy** -- validated with 557 test cases across 50+ categories
- **Magento-aware** -- understands controllers, plugins, observers, blocks, resolvers, repositories, and 20+ Magento patterns
- **AST-powered** -- tree-sitter parsing for PHP and JavaScript extracts classes, methods, namespaces, and inheritance
- **Fast** -- 15-45ms queries, ~3 minute indexing for full Magento 2.4.7
- **MCP server** -- integrates with Claude Code, Cursor, and any MCP-compatible AI tool
- **Hybrid architecture** -- Rust core for performance, Node.js for MCP integration

---

## Architecture

```
                    ┌──────────────────────────────────────────┐
                    │              Magector                     │
                    ├──────────────────┬───────────────────────┤
                    │   Rust Core      │   Node.js Layer       │
                    │                  │                       │
                    │  ┌────────────┐  │  ┌─────────────────┐  │
                    │  │ Tree-sitter│  │  │  MCP Server     │  │
                    │  │ AST Parser │  │  │  (16 tools)     │  │
                    │  │ PHP + JS   │  │  └────────┬────────┘  │
                    │  └─────┬──────┘  │           │           │
                    │        │         │  ┌────────┴────────┐  │
                    │  ┌─────┴──────┐  │  │  CLI Interface  │  │
                    │  │ Magento    │  │  │  index/search/  │  │
                    │  │ Pattern    │  │  │  validate       │  │
                    │  │ Detection  │  │  └─────────────────┘  │
                    │  └─────┬──────┘  │                       │
                    │        │         │                       │
                    │  ┌─────┴──────┐  │                       │
                    │  │ ONNX       │  │                       │
                    │  │ Embedder   │  │                       │
                    │  │ MiniLM-L6  │  │                       │
                    │  └─────┬──────┘  │                       │
                    │        │         │                       │
                    │  ┌─────┴──────┐  │                       │
                    │  │ HNSW       │  │                       │
                    │  │ Vector DB  │  │                       │
                    │  └────────────┘  │                       │
                    └──────────────────┴───────────────────────┘
```

### Embedding Pipeline

```
Source File ──▶ Tree-sitter AST ──▶ Magento Pattern Detection ──▶ Search Text Enrichment
     │                                                                     │
     │                                                                     ▼
     │                                                            ONNX Runtime
     │                                                            (MiniLM-L6-v2)
     │                                                                     │
     │                                                                     ▼
     │                                                             384-dim embedding
     │                                                                     │
     ▼                                                                     ▼
  Metadata ─────────────────────────────────────────────────────▶ HNSW Index
  (path, class, namespace, type, methods, patterns)               (17,891 vectors)
```

### Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Embeddings | `ort` (ONNX Runtime) | all-MiniLM-L6-v2, 384 dimensions |
| Vector search | `hnsw_rs` | Approximate nearest neighbor |
| PHP parsing | `tree-sitter-php` | Class, method, namespace extraction |
| JS parsing | `tree-sitter-javascript` | AMD/ES6 module detection |
| Pattern detection | Custom Rust | 20+ Magento-specific patterns |
| CLI | `clap` | Command-line interface |
| MCP server | `@modelcontextprotocol/sdk` | AI tool integration |

---

## Quick Start

### Prerequisites

- [Rust 1.75+](https://rustup.rs) (for building the core)
- [Node.js 18+](https://nodejs.org) (for MCP server)
- Git

### 1. Clone and Build

```bash
git clone https://github.com/AmiPotworworthy/magector.git
cd magector

# Install Node.js dependencies
npm install

# Build the Rust core
cd rust-core
cargo build --release
cd ..
```

### 2. Index a Magento Codebase

Using the Rust CLI (faster, with progress output):

```bash
./rust-core/target/release/magector-core index -m /path/to/magento2
```

Or using the Node.js CLI:

```bash
MAGENTO_ROOT=/path/to/magento2 npm run index
```

### 3. Search

```bash
# Semantic search
./rust-core/target/release/magector-core search "product price calculation"

# With result limit
./rust-core/target/release/magector-core search "checkout totals collector" -l 20

# JSON output
./rust-core/target/release/magector-core search "customer authentication" -f json
```

### 4. Set Up MCP Server (for Claude Code / Cursor)

```bash
# Automatic setup for Claude Code
./scripts/setup.sh

# Or manually
claude mcp add magector node src/mcp-server.js
```

For Cursor, add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "magector": {
      "command": "node",
      "args": ["/path/to/magector/src/mcp-server.js"],
      "env": {
        "MAGECTOR_DB": "/path/to/magector/magector.db",
        "MAGENTO_ROOT": "/path/to/magento2"
      }
    }
  }
}
```

---

## CLI Reference

### Rust Core CLI

```
magector-core <COMMAND>

Commands:
  index       Index a Magento codebase
  search      Search the index semantically
  validate    Run validation suite (downloads Magento if needed)
  download    Download Magento 2 Open Source
  stats       Show index statistics
  embed       Generate embedding for text
```

#### `index`

```bash
magector-core index [OPTIONS]

Options:
  -m, --magento-root <PATH>   Path to Magento root directory
  -d, --database <PATH>       Index database path [default: ./magector.db]
  -c, --model-cache <PATH>    Model cache directory [default: ./models]
  -v, --verbose               Enable verbose output
```

#### `search`

```bash
magector-core search <QUERY> [OPTIONS]

Options:
  -d, --database <PATH>   Index database path [default: ./magector.db]
  -l, --limit <N>         Number of results [default: 10]
  -f, --format <FORMAT>   Output format: text, json [default: text]
```

### Node.js CLI

```bash
npx magector index [path]       # Index Magento codebase
npx magector search <query>     # Search indexed code
npx magector stats              # Show indexer statistics
npx magector setup              # Generate Claude Code MCP config
npx magector mcp                # Start MCP server
npx magector validate           # Run validation suite
npx magector benchmark          # Run performance benchmarks
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MAGENTO_ROOT` | Path to Magento installation | Current directory |
| `MAGECTOR_DB` | Path to index database | `./magector.db` |

---

## MCP Server Tools

The MCP server exposes 16 tools for AI-assisted Magento development:

### Search Tools

| Tool | Description |
|------|-------------|
| `magento_search` | Semantic code search with natural language queries |
| `magento_find_class` | Find PHP class, interface, or trait by name |
| `magento_find_method` | Find method implementations across the codebase |

### Magento-Specific Finders

| Tool | Description |
|------|-------------|
| `magento_find_config` | Find XML configuration files (di.xml, events.xml, etc.) |
| `magento_find_template` | Find PHTML template files |
| `magento_find_plugin` | Find interceptor plugins and their targets |
| `magento_find_observer` | Find event observers |
| `magento_find_controller` | Find controllers by route or action |
| `magento_find_block` | Find Block classes |
| `magento_find_graphql` | Find GraphQL resolvers and schema |
| `magento_find_api` | Find REST API endpoints and webapi.xml routes |
| `magento_find_cron` | Find cron job definitions |
| `magento_find_db_schema` | Find database table definitions |

### Utility Tools

| Tool | Description |
|------|-------------|
| `magento_module_structure` | Show module directory structure |
| `magento_index` | Trigger re-indexing of the codebase |
| `magento_stats` | View index statistics |

### Query Examples

```
magento_search("how are checkout totals calculated")
magento_search("product price with tier pricing and catalog rules")
magento_find_class("ProductRepositoryInterface")
magento_find_config("di.xml plugin for ProductRepository")
magento_find_plugin("save method")
magento_find_observer("sales_order_place_after")
magento_find_api("products REST endpoint")
magento_find_graphql("cart mutation resolver")
```

---

## Validation

Magector is validated against the complete Magento 2.4.7 codebase with **557 test cases** across **50+ categories**.

### Overall Results

| Metric | Value |
|--------|-------|
| **Accuracy** | **94.8%** |
| Tests passed | 528 / 557 |
| Index size | 17,891 vectors |
| Query time | 15-45ms |
| Indexing time | ~3 minutes |

### Category Performance

**100% accuracy (34 categories):**
Controllers, Blocks, Observers, GraphQL, API, Shipping, Tax, Payment, EAV, Indexers, Cron, Email, Import, Export, Cache, Queue, Admin, CMS, Promotions, Debugging, Architecture, Order Management, Plugin Advanced, GraphQL Advanced, API Advanced, Admin Advanced, Email Advanced, Cron Advanced, Queue Advanced, Import Advanced, Payment Advanced, URL Rewrite, SEO, Marketing

**90-99% accuracy:**
Catalog Product (96%), Customer Advanced (95%), Checkout Flow (95%), Shipping Advanced (93.3%), Category (93.3%), Frontend JS (90%), Search (90%)

**Known limitations:**
- XML configuration file search (di.xml, plugin configs) -- semantic search favors PHP files with richer content
- Very generic single-word queries -- include more context for better results

### Running Validation

```bash
# Full validation (downloads Magento, indexes, validates)
cd rust-core
cargo run --release -- validate

# Skip indexing (use existing index)
cargo run --release -- validate -m ./magento2 --skip-index

# Node.js validation suite
npm run validate
npm run validate:verbose
```

---

## Project Structure

```
magector/
├── src/                          # Node.js source
│   ├── cli.js                    # Node.js CLI entry point
│   ├── mcp-server.js             # MCP server (16 tools)
│   ├── indexer.js                # Node.js indexer (hybrid search, re-ranking)
│   ├── magento-patterns.js       # Magento pattern detection (JS)
│   └── validation/               # JS validation suite
│       ├── validator.js
│       ├── real-validator.js
│       ├── developer-validator.js
│       ├── benchmark.js
│       ├── test-queries.js
│       ├── test-data-generator.js
│       └── accuracy-calculator.js
├── rust-core/                    # Rust high-performance core
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs               # Rust CLI (index, search, validate)
│   │   ├── lib.rs                # Library exports
│   │   ├── indexer.rs             # Core indexing with progress output
│   │   ├── embedder.rs            # ONNX embedding (MiniLM-L6-v2)
│   │   ├── vectordb.rs            # HNSW vector database
│   │   ├── ast.rs                 # Tree-sitter AST (PHP + JS)
│   │   ├── magento.rs             # Magento pattern detection (Rust)
│   │   └── validation.rs          # 557 test cases, validation framework
│   └── models/                   # ONNX model files (auto-downloaded)
│       ├── all-MiniLM-L6-v2.onnx
│       └── tokenizer.json
├── scripts/
│   └── setup.sh                  # Claude Code MCP setup script
├── config/
│   └── mcp-config.json           # MCP server configuration template
├── package.json
├── .gitignore
├── .cursorrules                  # Cursor IDE rules for Magento development
├── LICENSE
└── README.md
```

---

## How It Works

### 1. Indexing

Magector scans every `.php`, `.js`, `.xml`, `.phtml`, and `.graphqls` file in a Magento codebase:

1. **AST parsing** -- Tree-sitter extracts class names, namespaces, methods, inheritance, and interface implementations from PHP and JavaScript files
2. **Pattern detection** -- Identifies Magento-specific patterns: controllers, models, repositories, plugins, observers, blocks, GraphQL resolvers, admin grids, cron jobs, and more
3. **Search text enrichment** -- Combines AST metadata with Magento pattern keywords to create semantically rich text representations
4. **Embedding** -- ONNX Runtime generates 384-dimensional vectors using all-MiniLM-L6-v2
5. **Indexing** -- Vectors are stored in an HNSW index for sub-millisecond approximate nearest neighbor search

### 2. Searching

1. Query text is enriched with pattern synonyms (e.g., "controller" adds "action execute http request dispatch")
2. The enriched query is embedded into the same 384-dimensional vector space
3. HNSW finds the nearest neighbors by cosine similarity
4. Results are ranked and returned with file path, class name, Magento type, and relevance score

### 3. MCP Integration

The Node.js MCP server wraps the indexer with 16 specialized tools. When an AI assistant like Claude Code or Cursor needs to find Magento code, it calls the appropriate tool:

```
Developer: "How does checkout totals calculation work?"
     │
     ▼
AI Assistant ──▶ magento_search("checkout totals collector calculate")
     │
     ▼
MCP Server ──▶ Indexer.search() ──▶ HNSW lookup ──▶ Ranked results
     │
     ▼
Results:
  1. Quote/Model/Quote/TotalsCollector.php (0.554)
  2. Quote/Model/Quote/Address/Total/Collector.php (0.524)
  3. Quote/Model/Quote/Address/Total/Subtotal.php (0.517)
```

---

## Magento Patterns Detected

Magector understands these Magento 2 architectural patterns:

| Pattern | Detection Method | Example |
|---------|-----------------|---------|
| Controller | Path + `execute()` method | `Controller/Adminhtml/Order/View.php` |
| Model | Path + extends `AbstractModel` | `Model/Product.php` |
| Repository | Path + implements `RepositoryInterface` | `Model/ProductRepository.php` |
| Block | Path + extends `AbstractBlock` | `Block/Product/View.php` |
| Plugin | Path + before/after/around methods | `Plugin/Product/SavePlugin.php` |
| Observer | Path + implements `ObserverInterface` | `Observer/ProductSaveObserver.php` |
| GraphQL Resolver | Path + implements `ResolverInterface` | `Model/Resolver/Products.php` |
| Helper | Path under `Helper/` | `Helper/Data.php` |
| Cron | Path under `Cron/` | `Cron/CleanExpiredQuotes.php` |
| Console Command | Path + extends `Command` | `Console/Command/IndexerReindex.php` |
| Data Provider | Path + `DataProvider` | `Ui/DataProvider/Product/Listing.php` |
| ViewModel | Path + implements `ArgumentInterface` | `ViewModel/Product/Breadcrumbs.php` |
| Setup Patch | Path + `Patch/Data` or `Patch/Schema` | `Setup/Patch/Data/AddAttribute.php` |
| di.xml | Path matching | `etc/di.xml`, `etc/frontend/di.xml` |
| events.xml | Path matching | `etc/events.xml` |
| webapi.xml | Path matching | `etc/webapi.xml` |
| layout XML | Path under `layout/` | `view/frontend/layout/catalog_product_view.xml` |
| Template | `.phtml` extension | `view/frontend/templates/product/view.phtml` |
| JavaScript | `.js` with AMD/ES6 detection | `view/frontend/web/js/view/minicart.js` |
| GraphQL Schema | `.graphqls` extension | `etc/schema.graphqls` |

---

## Configuration

### Cursor IDE Rules

Copy `.cursorrules` to your Magento project root for optimized AI-assisted development. The rules instruct the AI to:

1. Use Magector MCP tools before reading files manually
2. Write effective semantic queries
3. Follow Magento development patterns
4. Interpret search results correctly

### Model Configuration

The ONNX model (`all-MiniLM-L6-v2`) is automatically downloaded on first run to `rust-core/models/`. To use a different location:

```bash
magector-core index -m /path/to/magento -c /custom/model/path
```

---

## Development

### Building

```bash
# Rust core
cd rust-core
cargo build --release

# Run unit tests
cargo test

# Run validation
cargo run --release -- validate
```

### Adding New Magento Patterns

1. Add pattern detection in `rust-core/src/magento.rs`
2. Add search text enrichment in `rust-core/src/indexer.rs`
3. Add validation test cases in `rust-core/src/validation.rs`
4. Rebuild and run validation to verify:

```bash
cargo build --release
./target/release/magector-core validate -m ./magento2 --skip-index
```

### Adding MCP Tools

1. Define the tool schema in `src/mcp-server.js` (ListToolsRequestSchema handler)
2. Implement the handler in the CallToolRequestSchema handler
3. Test with Claude Code or the MCP inspector

---

## Technical Details

### Embedding Model

- **Model:** all-MiniLM-L6-v2
- **Dimensions:** 384
- **Pooling:** Mean pooling with attention mask
- **Normalization:** L2 normalized
- **Runtime:** ONNX Runtime (via `ort` crate)

### Vector Index

- **Algorithm:** HNSW (Hierarchical Navigable Small World)
- **Library:** `hnsw_rs`
- **Distance metric:** Cosine similarity
- **Persistence:** JSON serialization (HNSW + metadata)

### Index Structure

Each indexed file produces a vector entry with metadata:

```rust
struct IndexMetadata {
    path: String,
    file_type: String,          // php, xml, js, template, graphql
    magento_type: String,       // controller, model, block, plugin, ...
    class_name: Option<String>,
    namespace: Option<String>,
    methods: Vec<String>,
    search_text: String,        // Enriched searchable text
    is_controller: bool,
    is_plugin: bool,
    is_observer: bool,
    is_model: bool,
    is_block: bool,
    // ... 20+ pattern flags
}
```

### Performance Characteristics

| Operation | Time | Notes |
|-----------|------|-------|
| Full index (18K files) | ~3 min | Parallel file parsing, sequential embedding |
| Single query | 15-45ms | HNSW approximate nearest neighbor |
| Embedding generation | ~2ms | ONNX Runtime with CoreML/CUDA |
| Model load | ~500ms | One-time at startup |
| Index load | ~2s | JSON deserialization |

---

## Roadmap

- [ ] Hybrid search (semantic + BM25 keyword matching)
- [ ] Query intent classification (auto-detect "give me XML" vs "give me PHP")
- [ ] Filtered search by file type at the vector level
- [ ] Incremental indexing (only re-index changed files)
- [ ] VSCode extension
- [ ] Web UI for browsing results
- [ ] Support for Magento 2 Commerce (B2B, Staging modules)

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

## Contributing

Contributions are welcome. Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/improvement`)
3. Add tests for new functionality
4. Run validation to ensure accuracy doesn't regress
5. Submit a pull request

---

Built with Rust and Node.js for the Magento community.
