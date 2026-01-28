//! Magector Core - Rust-based Magento code indexer
//!
//! Provides semantic code search using ONNX embeddings and HNSW vector search.

pub mod ast;
pub mod embedder;
pub mod indexer;
pub mod magento;
pub mod validation;
pub mod vectordb;

pub use ast::{PhpAstAnalyzer, PhpAstMetadata, JsAstAnalyzer, JsAstMetadata};
pub use embedder::{Embedder, EMBEDDING_DIM};
pub use indexer::{IndexStats, Indexer};
pub use magento::{detect_file_type, MagentoFileType, XmlAnalyzer};
pub use validation::{ValidationReport, Validator};
pub use vectordb::{IndexMetadata, SearchResult, VectorDB};
