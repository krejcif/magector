//! AST-based code analysis using tree-sitter
//!
//! Provides accurate parsing for PHP and JavaScript files

use tree_sitter::{Language, Parser, Node, Query, QueryCursor};
use streaming_iterator::StreamingIterator;

/// Get PHP language for tree-sitter
fn get_php_language() -> Language {
    tree_sitter_php::LANGUAGE_PHP.into()
}

/// Get JavaScript language for tree-sitter
fn get_javascript_language() -> Language {
    tree_sitter_javascript::LANGUAGE.into()
}

/// PHP AST Analyzer
pub struct PhpAstAnalyzer {
    parser: Parser,
}

/// Extracted PHP metadata from AST
#[derive(Debug, Clone, Default)]
pub struct PhpAstMetadata {
    pub namespace: Option<String>,
    pub class_name: Option<String>,
    pub class_type: Option<String>, // class, interface, trait, abstract, final
    pub extends: Option<String>,
    pub implements: Vec<String>,
    pub traits: Vec<String>,
    pub methods: Vec<PhpMethod>,
    pub properties: Vec<PhpProperty>,
    pub constants: Vec<String>,
    pub uses: Vec<UseStatement>,
    // Magento-specific
    pub is_controller: bool,
    pub is_repository: bool,
    pub is_plugin: bool,
    pub is_observer: bool,
    pub is_model: bool,
    pub is_block: bool,
    pub is_resolver: bool,
    pub is_api_interface: bool,
    pub is_helper: bool,
    pub is_setup: bool,
    pub plugin_methods: Vec<PluginMethod>,
    pub event_handlers: Vec<String>,
    pub di_injections: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PhpMethod {
    pub name: String,
    pub visibility: String,
    pub is_static: bool,
    pub is_abstract: bool,
    pub parameters: Vec<PhpParameter>,
    pub return_type: Option<String>,
    pub doc_comment: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PhpParameter {
    pub name: String,
    pub type_hint: Option<String>,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PhpProperty {
    pub name: String,
    pub visibility: String,
    pub type_hint: Option<String>,
    pub is_static: bool,
}

#[derive(Debug, Clone)]
pub struct UseStatement {
    pub full_path: String,
    pub alias: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PluginMethod {
    pub method_type: String, // before, after, around
    pub target_method: String,
}

/// Result of running a tree-sitter query against PHP source code.
#[derive(Debug, Clone)]
pub struct AstQueryMatch {
    pub file: String,
    pub line: usize,
    pub end_line: usize,
    pub snippet: String,
    /// Captured text for each named capture, keyed by capture name.
    pub captures: Vec<(String, String)>,
}

impl PhpAstAnalyzer {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let language = get_php_language();
        let mut parser = Parser::new();
        parser.set_language(&language)?;

        Ok(Self { parser })
    }

    /// Analyze PHP source code
    pub fn analyze(&mut self, source: &str) -> PhpAstMetadata {
        let mut metadata = PhpAstMetadata::default();

        // Add PHP open tag if missing (tree-sitter-php requires it)
        let source = if !source.trim_start().starts_with("<?") {
            format!("<?php\n{}", source)
        } else {
            source.to_string()
        };

        let tree = match self.parser.parse(&source, None) {
            Some(tree) => tree,
            None => return metadata,
        };

        let root = tree.root_node();
        let source_bytes = source.as_bytes();

        // Walk the tree and extract information
        self.walk_tree(&root, source_bytes, &mut metadata);

        // Detect Magento patterns based on collected data
        self.detect_magento_patterns(&mut metadata);

        metadata
    }

    /// Run a tree-sitter query against PHP source code.
    /// Returns matches with line numbers, snippets, and named captures.
    pub fn run_query(&mut self, source: &str, query_source: &str) -> Result<Vec<AstQueryMatch>, String> {
        let tree = self.parser.parse(source, None)
            .ok_or("Failed to parse PHP")?;
        let lang = get_php_language();
        let query = Query::new(&lang, query_source)
            .map_err(|e| format!("Invalid query: {:?}", e))?;
        let mut cursor = QueryCursor::new();
        let capture_names: Vec<&str> = query.capture_names().to_vec();

        let mut results = Vec::new();
        let root = tree.root_node();
        let src_bytes = source.as_bytes();

        // QueryMatches implements StreamingIterator, not Iterator
        let mut matches = cursor.matches(&query, root, src_bytes);
        while let Some(m) = matches.next() {
            // Use the first capture as the match location
            if let Some(capture) = m.captures.first() {
                let node = capture.node;
                let start = node.start_position();
                let end = node.end_position();
                // Get the full line(s) containing the match
                let lines: Vec<&str> = source.lines().collect();
                let snippet_lines: Vec<&str> = lines[start.row..=end.row.min(lines.len() - 1)].to_vec();

                // Collect all named captures
                let mut captures = Vec::new();
                for cap in m.captures {
                    let cap_name = capture_names.get(cap.index as usize)
                        .copied()
                        .unwrap_or("unknown");
                    let cap_text = cap.node.utf8_text(src_bytes)
                        .unwrap_or("")
                        .to_string();
                    captures.push((cap_name.to_string(), cap_text));
                }

                results.push(AstQueryMatch {
                    file: String::new(), // caller fills in
                    line: start.row + 1,
                    end_line: end.row + 1,
                    snippet: snippet_lines.join("\n").trim().to_string(),
                    captures,
                });
            }
        }
        Ok(results)
    }

    fn walk_tree(&self, node: &Node, source: &[u8], metadata: &mut PhpAstMetadata) {
        match node.kind() {
            "namespace_definition" => {
                self.extract_namespace(node, source, metadata);
            }
            "class_declaration" => {
                self.extract_class(node, source, metadata);
            }
            "interface_declaration" => {
                self.extract_interface(node, source, metadata);
            }
            "trait_declaration" => {
                self.extract_trait(node, source, metadata);
            }
            "method_declaration" => {
                self.extract_method(node, source, metadata);
            }
            "property_declaration" => {
                self.extract_property(node, source, metadata);
            }
            "namespace_use_declaration" => {
                self.extract_use(node, source, metadata);
            }
            _ => {}
        }

        // Recurse into children
        let child_count = node.child_count();
        for i in 0..child_count {
            if let Some(child) = node.child(i) {
                self.walk_tree(&child, source, metadata);
            }
        }
    }

    fn extract_namespace(&self, node: &Node, source: &[u8], metadata: &mut PhpAstMetadata) {
        // Find the namespace_name child
        let child_count = node.child_count();
        for i in 0..child_count {
            if let Some(child) = node.child(i) {
                if child.kind() == "namespace_name" {
                    if let Ok(text) = child.utf8_text(source) {
                        metadata.namespace = Some(text.to_string());
                    }
                }
            }
        }
    }

    fn extract_class(&self, node: &Node, source: &[u8], metadata: &mut PhpAstMetadata) {
        let child_count = node.child_count();

        // Check for abstract/final modifiers
        let mut is_abstract = false;
        let mut is_final = false;

        for i in 0..child_count {
            if let Some(child) = node.child(i) {
                match child.kind() {
                    "abstract_modifier" => is_abstract = true,
                    "final_modifier" => is_final = true,
                    "name" => {
                        if let Ok(text) = child.utf8_text(source) {
                            metadata.class_name = Some(text.to_string());
                        }
                    }
                    "base_clause" => {
                        // Extract extends
                        for j in 0..child.child_count() {
                            if let Some(base_child) = child.child(j) {
                                if base_child.kind() == "name" || base_child.kind() == "qualified_name" {
                                    if let Ok(text) = base_child.utf8_text(source) {
                                        metadata.extends = Some(text.to_string());
                                    }
                                }
                            }
                        }
                    }
                    "class_interface_clause" => {
                        // Extract implements
                        for j in 0..child.child_count() {
                            if let Some(impl_child) = child.child(j) {
                                if impl_child.kind() == "name" || impl_child.kind() == "qualified_name" {
                                    if let Ok(text) = impl_child.utf8_text(source) {
                                        metadata.implements.push(text.to_string());
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        if is_abstract {
            metadata.class_type = Some("abstract class".to_string());
        } else if is_final {
            metadata.class_type = Some("final class".to_string());
        } else {
            metadata.class_type = Some("class".to_string());
        }
    }

    fn extract_interface(&self, node: &Node, source: &[u8], metadata: &mut PhpAstMetadata) {
        let child_count = node.child_count();
        for i in 0..child_count {
            if let Some(child) = node.child(i) {
                if child.kind() == "name" {
                    if let Ok(text) = child.utf8_text(source) {
                        metadata.class_name = Some(text.to_string());
                        metadata.class_type = Some("interface".to_string());
                    }
                }
            }
        }
    }

    fn extract_trait(&self, node: &Node, source: &[u8], metadata: &mut PhpAstMetadata) {
        let child_count = node.child_count();
        for i in 0..child_count {
            if let Some(child) = node.child(i) {
                if child.kind() == "name" {
                    if let Ok(text) = child.utf8_text(source) {
                        metadata.class_name = Some(text.to_string());
                        metadata.class_type = Some("trait".to_string());
                    }
                }
            }
        }
    }

    fn extract_method(&self, node: &Node, source: &[u8], metadata: &mut PhpAstMetadata) {
        let mut method = PhpMethod {
            name: String::new(),
            visibility: "public".to_string(),
            is_static: false,
            is_abstract: false,
            parameters: Vec::new(),
            return_type: None,
            doc_comment: None,
        };

        let child_count = node.child_count();
        for i in 0..child_count {
            if let Some(child) = node.child(i) {
                match child.kind() {
                    "visibility_modifier" => {
                        if let Ok(text) = child.utf8_text(source) {
                            method.visibility = text.to_string();
                        }
                    }
                    "static_modifier" => method.is_static = true,
                    "abstract_modifier" => method.is_abstract = true,
                    "name" => {
                        if let Ok(text) = child.utf8_text(source) {
                            method.name = text.to_string();
                        }
                    }
                    "formal_parameters" => {
                        method.parameters = self.extract_parameters(&child, source);
                    }
                    _ => {
                        // Check for return type
                        if child.kind().contains("type") {
                            if let Ok(text) = child.utf8_text(source) {
                                method.return_type = Some(text.to_string());
                            }
                        }
                    }
                }
            }
        }

        if !method.name.is_empty() {
            // Detect plugin methods
            if method.name.starts_with("before") && method.name.len() > 6 {
                metadata.plugin_methods.push(PluginMethod {
                    method_type: "before".to_string(),
                    target_method: method.name[6..].to_string(),
                });
            } else if method.name.starts_with("after") && method.name.len() > 5 {
                metadata.plugin_methods.push(PluginMethod {
                    method_type: "after".to_string(),
                    target_method: method.name[5..].to_string(),
                });
            } else if method.name.starts_with("around") && method.name.len() > 6 {
                metadata.plugin_methods.push(PluginMethod {
                    method_type: "around".to_string(),
                    target_method: method.name[6..].to_string(),
                });
            }

            metadata.methods.push(method);
        }
    }

    fn extract_parameters(&self, node: &Node, source: &[u8]) -> Vec<PhpParameter> {
        let mut params = Vec::new();
        let child_count = node.child_count();

        for i in 0..child_count {
            if let Some(child) = node.child(i) {
                if child.kind() == "simple_parameter" || child.kind() == "property_promotion_parameter" {
                    let mut param = PhpParameter {
                        name: String::new(),
                        type_hint: None,
                        default_value: None,
                    };

                    let param_child_count = child.child_count();
                    for j in 0..param_child_count {
                        if let Some(param_child) = child.child(j) {
                            match param_child.kind() {
                                "variable_name" => {
                                    if let Ok(text) = param_child.utf8_text(source) {
                                        param.name = text.trim_start_matches('$').to_string();
                                    }
                                }
                                kind if kind.contains("type") => {
                                    if let Ok(text) = param_child.utf8_text(source) {
                                        param.type_hint = Some(text.to_string());
                                    }
                                }
                                _ => {}
                            }
                        }
                    }

                    if !param.name.is_empty() {
                        params.push(param);
                    }
                }
            }
        }

        params
    }

    fn extract_property(&self, node: &Node, source: &[u8], metadata: &mut PhpAstMetadata) {
        let mut prop = PhpProperty {
            name: String::new(),
            visibility: "public".to_string(),
            type_hint: None,
            is_static: false,
        };

        let child_count = node.child_count();
        for i in 0..child_count {
            if let Some(child) = node.child(i) {
                match child.kind() {
                    "visibility_modifier" => {
                        if let Ok(text) = child.utf8_text(source) {
                            prop.visibility = text.to_string();
                        }
                    }
                    "static_modifier" => prop.is_static = true,
                    "property_element" => {
                        for j in 0..child.child_count() {
                            if let Some(prop_child) = child.child(j) {
                                if prop_child.kind() == "variable_name" {
                                    if let Ok(text) = prop_child.utf8_text(source) {
                                        prop.name = text.trim_start_matches('$').to_string();
                                    }
                                }
                            }
                        }
                    }
                    _ => {
                        if child.kind().contains("type") {
                            if let Ok(text) = child.utf8_text(source) {
                                prop.type_hint = Some(text.to_string());
                            }
                        }
                    }
                }
            }
        }

        if !prop.name.is_empty() {
            metadata.properties.push(prop);
        }
    }

    fn extract_use(&self, node: &Node, source: &[u8], metadata: &mut PhpAstMetadata) {
        let child_count = node.child_count();
        for i in 0..child_count {
            if let Some(child) = node.child(i) {
                if child.kind() == "namespace_use_clause" {
                    let mut use_stmt = UseStatement {
                        full_path: String::new(),
                        alias: None,
                    };

                    let clause_child_count = child.child_count();
                    for j in 0..clause_child_count {
                        if let Some(clause_child) = child.child(j) {
                            match clause_child.kind() {
                                "qualified_name" | "name" => {
                                    if let Ok(text) = clause_child.utf8_text(source) {
                                        use_stmt.full_path = text.to_string();
                                    }
                                }
                                "namespace_aliasing_clause" => {
                                    for k in 0..clause_child.child_count() {
                                        if let Some(alias_child) = clause_child.child(k) {
                                            if alias_child.kind() == "name" {
                                                if let Ok(text) = alias_child.utf8_text(source) {
                                                    use_stmt.alias = Some(text.to_string());
                                                }
                                            }
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }

                    if !use_stmt.full_path.is_empty() {
                        // Track DI injections
                        if use_stmt.full_path.contains("Interface") || use_stmt.full_path.contains("Factory") {
                            metadata.di_injections.push(use_stmt.full_path.clone());
                        }
                        metadata.uses.push(use_stmt);
                    }
                }
            }
        }
    }

    fn detect_magento_patterns(&self, metadata: &mut PhpAstMetadata) {
        // Controller detection
        metadata.is_controller = metadata.implements.iter().any(|i| i.contains("ActionInterface"))
            || metadata.extends.as_ref().map_or(false, |e| e.contains("Action"))
            || metadata.methods.iter().any(|m| m.name == "execute");

        // Repository detection
        metadata.is_repository = metadata.implements.iter().any(|i| i.contains("RepositoryInterface"))
            || metadata.class_name.as_ref().map_or(false, |n| n.contains("Repository"))
            || metadata.namespace.as_ref().map_or(false, |n| n.contains("Repository"));

        // Plugin detection — method-based or class name / namespace
        metadata.is_plugin = !metadata.plugin_methods.is_empty()
            || metadata.class_name.as_ref().map_or(false, |n| n.contains("Plugin"))
            || metadata.namespace.as_ref().map_or(false, |n| n.contains("\\Plugin\\"));

        // Observer detection
        metadata.is_observer = metadata.implements.iter().any(|i| i.contains("ObserverInterface"));

        // Model detection
        metadata.is_model = metadata.extends.as_ref().map_or(false, |e| {
            e.contains("AbstractModel") || e.contains("AbstractDb")
        });

        // Block detection
        metadata.is_block = metadata.extends.as_ref().map_or(false, |e| {
            e.contains("Template") || e.contains("AbstractBlock")
        });

        // Helper detection — extends AbstractHelper or namespace/class contains Helper
        metadata.is_helper = metadata.extends.as_ref().map_or(false, |e| {
            e.contains("AbstractHelper") || e.contains("AbstractData")
        }) || metadata.class_name.as_ref().map_or(false, |n| n.contains("Helper"))
            || metadata.namespace.as_ref().map_or(false, |n| n.contains("\\Helper\\") || n.ends_with("\\Helper"));

        // Setup detection — implements DataPatchInterface, SchemaPatchInterface, etc.
        metadata.is_setup = metadata.implements.iter().any(|i| {
            i.contains("PatchInterface") || i.contains("InstallSchemaInterface")
                || i.contains("InstallDataInterface") || i.contains("UpgradeSchemaInterface")
                || i.contains("UpgradeDataInterface")
        }) || metadata.namespace.as_ref().map_or(false, |n| n.contains("\\Setup\\") || n.ends_with("\\Setup"))
            || metadata.class_name.as_ref().map_or(false, |n| {
                n.contains("InstallSchema") || n.contains("InstallData")
                    || n.contains("UpgradeSchema") || n.contains("UpgradeData")
                    || n.contains("Patch")
            });

        // GraphQL Resolver detection
        metadata.is_resolver = metadata.implements.iter().any(|i| {
            i.contains("ResolverInterface") || i.contains("BatchResolverInterface")
        });

        // API Interface detection
        metadata.is_api_interface = metadata.class_type.as_ref().map_or(false, |t| t == "interface")
            && metadata.namespace.as_ref().map_or(false, |n| n.contains("Api"));
    }
}

impl Default for PhpAstAnalyzer {
    fn default() -> Self {
        Self::new().expect("Failed to create PHP AST analyzer")
    }
}

/// JavaScript AST Analyzer
pub struct JsAstAnalyzer {
    parser: Parser,
}

/// Extracted JavaScript metadata from AST
#[derive(Debug, Clone, Default)]
pub struct JsAstMetadata {
    pub module_type: Option<String>, // amd, esm, umd, iife
    pub exports: Vec<String>,
    pub imports: Vec<JsImport>,
    pub classes: Vec<JsClass>,
    pub functions: Vec<JsFunction>,
    pub components: Vec<String>, // UI Components, Widgets
    pub dependencies: Vec<String>,
    pub define_deps: Vec<String>, // AMD define dependencies
    // Magento-specific
    pub is_ui_component: bool,
    pub is_widget: bool,
    pub is_mixin: bool,
    pub is_knockout_component: bool,
    pub component_name: Option<String>,
    pub mixin_target: Option<String>,
}

#[derive(Debug, Clone)]
pub struct JsImport {
    pub source: String,
    pub specifiers: Vec<String>,
    pub is_default: bool,
}

#[derive(Debug, Clone)]
pub struct JsClass {
    pub name: String,
    pub extends: Option<String>,
    pub methods: Vec<String>,
    pub properties: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct JsFunction {
    pub name: String,
    pub is_async: bool,
    pub is_generator: bool,
    pub parameters: Vec<String>,
}

impl JsAstAnalyzer {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let language = get_javascript_language();
        let mut parser = Parser::new();
        parser.set_language(&language)?;

        Ok(Self { parser })
    }

    /// Analyze JavaScript source code
    pub fn analyze(&mut self, source: &str) -> JsAstMetadata {
        let mut metadata = JsAstMetadata::default();

        let tree = match self.parser.parse(source, None) {
            Some(tree) => tree,
            None => return metadata,
        };

        let root = tree.root_node();
        let source_bytes = source.as_bytes();

        // Detect module type from source patterns
        self.detect_module_type(source, &mut metadata);

        // Walk tree and extract info
        self.walk_tree(&root, source_bytes, &mut metadata);

        // Detect Magento-specific patterns
        self.detect_magento_patterns(source, &mut metadata);

        metadata
    }

    fn detect_module_type(&self, source: &str, metadata: &mut JsAstMetadata) {
        if source.contains("define(") || source.contains("define([") {
            metadata.module_type = Some("amd".to_string());
            // Extract AMD dependencies
            self.extract_amd_deps(source, metadata);
        } else if source.contains("import ") || source.contains("export ") {
            metadata.module_type = Some("esm".to_string());
        } else if source.contains("module.exports") || source.contains("require(") {
            metadata.module_type = Some("commonjs".to_string());
        } else if source.contains("(function(") && source.contains("})(") {
            metadata.module_type = Some("iife".to_string());
        }
    }

    fn extract_amd_deps(&self, source: &str, metadata: &mut JsAstMetadata) {
        // Find define([...], function...)
        if let Some(define_pos) = source.find("define(") {
            let rest = &source[define_pos..];
            if let Some(bracket_start) = rest.find('[') {
                if let Some(bracket_end) = rest[bracket_start..].find(']') {
                    let deps_str = &rest[bracket_start + 1..bracket_start + bracket_end];
                    for dep in deps_str.split(',') {
                        let dep = dep.trim().trim_matches(|c| c == '\'' || c == '"');
                        if !dep.is_empty() {
                            metadata.define_deps.push(dep.to_string());
                            metadata.dependencies.push(dep.to_string());
                        }
                    }
                }
            }
        }
    }

    fn walk_tree(&self, node: &Node, source: &[u8], metadata: &mut JsAstMetadata) {
        match node.kind() {
            "import_statement" => {
                self.extract_import(node, source, metadata);
            }
            "class_declaration" | "class" => {
                self.extract_class(node, source, metadata);
            }
            "function_declaration" => {
                self.extract_function(node, source, metadata);
            }
            "export_statement" => {
                self.extract_export(node, source, metadata);
            }
            "call_expression" => {
                self.extract_call(node, source, metadata);
            }
            _ => {}
        }

        // Recurse into children
        let child_count = node.child_count();
        for i in 0..child_count {
            if let Some(child) = node.child(i) {
                self.walk_tree(&child, source, metadata);
            }
        }
    }

    fn extract_import(&self, node: &Node, source: &[u8], metadata: &mut JsAstMetadata) {
        let mut import = JsImport {
            source: String::new(),
            specifiers: Vec::new(),
            is_default: false,
        };

        let child_count = node.child_count();
        for i in 0..child_count {
            if let Some(child) = node.child(i) {
                match child.kind() {
                    "string" => {
                        if let Ok(text) = child.utf8_text(source) {
                            import.source = text.trim_matches(|c| c == '\'' || c == '"').to_string();
                        }
                    }
                    "import_clause" => {
                        // Check for default import
                        if let Ok(text) = child.utf8_text(source) {
                            if !text.contains('{') {
                                import.is_default = true;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        if !import.source.is_empty() {
            metadata.dependencies.push(import.source.clone());
            metadata.imports.push(import);
        }
    }

    fn extract_class(&self, node: &Node, source: &[u8], metadata: &mut JsAstMetadata) {
        let mut class = JsClass {
            name: String::new(),
            extends: None,
            methods: Vec::new(),
            properties: Vec::new(),
        };

        let child_count = node.child_count();
        for i in 0..child_count {
            if let Some(child) = node.child(i) {
                match child.kind() {
                    "identifier" => {
                        if class.name.is_empty() {
                            if let Ok(text) = child.utf8_text(source) {
                                class.name = text.to_string();
                            }
                        }
                    }
                    "class_heritage" => {
                        // Extract extends
                        for j in 0..child.child_count() {
                            if let Some(heritage_child) = child.child(j) {
                                if heritage_child.kind() == "identifier" {
                                    if let Ok(text) = heritage_child.utf8_text(source) {
                                        class.extends = Some(text.to_string());
                                    }
                                }
                            }
                        }
                    }
                    "class_body" => {
                        // Extract methods
                        for j in 0..child.child_count() {
                            if let Some(body_child) = child.child(j) {
                                if body_child.kind() == "method_definition" {
                                    for k in 0..body_child.child_count() {
                                        if let Some(method_child) = body_child.child(k) {
                                            if method_child.kind() == "property_identifier" {
                                                if let Ok(text) = method_child.utf8_text(source) {
                                                    class.methods.push(text.to_string());
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        if !class.name.is_empty() {
            metadata.classes.push(class);
        }
    }

    fn extract_function(&self, node: &Node, source: &[u8], metadata: &mut JsAstMetadata) {
        let mut func = JsFunction {
            name: String::new(),
            is_async: false,
            is_generator: false,
            parameters: Vec::new(),
        };

        if let Ok(text) = node.utf8_text(source) {
            func.is_async = text.starts_with("async");
            func.is_generator = text.contains("function*");
        }

        let child_count = node.child_count();
        for i in 0..child_count {
            if let Some(child) = node.child(i) {
                if child.kind() == "identifier" {
                    if let Ok(text) = child.utf8_text(source) {
                        func.name = text.to_string();
                    }
                }
            }
        }

        if !func.name.is_empty() {
            metadata.functions.push(func);
        }
    }

    fn extract_export(&self, node: &Node, source: &[u8], metadata: &mut JsAstMetadata) {
        if let Ok(text) = node.utf8_text(source) {
            if text.contains("export default") {
                metadata.exports.push("default".to_string());
            } else if text.contains("export {") {
                if let Some(start) = text.find('{') {
                    if let Some(end) = text.find('}') {
                        let exports_str = &text[start + 1..end];
                        for exp in exports_str.split(',') {
                            let exp = exp.trim().split(" as ").next().unwrap_or("").trim();
                            if !exp.is_empty() {
                                metadata.exports.push(exp.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    fn extract_call(&self, node: &Node, source: &[u8], metadata: &mut JsAstMetadata) {
        if let Ok(text) = node.utf8_text(source) {
            // Check for require()
            if text.starts_with("require(") {
                if let Some(start) = text.find('\'').or_else(|| text.find('"')) {
                    if let Some(end) = text[start + 1..].find(|c| c == '\'' || c == '"') {
                        let path = &text[start + 1..start + 1 + end];
                        if !metadata.dependencies.contains(&path.to_string()) {
                            metadata.dependencies.push(path.to_string());
                        }
                    }
                }
            }
        }
    }

    fn detect_magento_patterns(&self, source: &str, metadata: &mut JsAstMetadata) {
        // UI Component detection
        metadata.is_ui_component = source.contains("uiComponent")
            || source.contains("Magento_Ui/js/")
            || metadata.dependencies.iter().any(|d| d.contains("uiComponent"));

        // Widget detection (jQuery UI widget pattern)
        metadata.is_widget = source.contains("$.widget(")
            || source.contains("jQuery.widget(")
            || source.contains("$.mage.")
            || metadata.dependencies.iter().any(|d| d.contains("jquery/ui"));

        // Mixin detection
        metadata.is_mixin = source.contains("'mixins':")
            || source.contains("return function (target)")
            || source.contains("return function(target)");

        if metadata.is_mixin {
            // Try to extract mixin target
            if let Some(idx) = source.find("'mixins':") {
                let rest = &source[idx..];
                if let Some(start) = rest.find('\'').or_else(|| rest.find('"')) {
                    if let Some(end) = rest[start + 1..].find(|c| c == '\'' || c == '"') {
                        metadata.mixin_target = Some(rest[start + 1..start + 1 + end].to_string());
                    }
                }
            }
        }

        // Knockout component detection
        metadata.is_knockout_component = source.contains("ko.component")
            || source.contains("ko.bindingHandlers")
            || metadata.dependencies.iter().any(|d| d == "ko" || d == "knockout");

        // Extract component name
        if source.contains("Component.extend(") {
            metadata.component_name = metadata.classes.first().map(|c| c.name.clone());
        }
    }
}

impl Default for JsAstAnalyzer {
    fn default() -> Self {
        Self::new().expect("Failed to create JS AST analyzer")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_php_class_extraction() {
        let mut analyzer = PhpAstAnalyzer::new().unwrap();
        let source = r#"<?php
namespace Vendor\Module\Model;

use Magento\Framework\Model\AbstractModel;

class Product extends AbstractModel implements ProductInterface
{
    public function getName(): string
    {
        return $this->getData('name');
    }
}
"#;
        let meta = analyzer.analyze(source);
        assert_eq!(meta.class_name, Some("Product".to_string()));
        assert_eq!(meta.namespace, Some("Vendor\\Module\\Model".to_string()));
        assert!(meta.extends.is_some());
        assert!(meta.is_model);
    }

    #[test]
    fn test_js_amd_detection() {
        let mut analyzer = JsAstAnalyzer::new().unwrap();
        let source = r#"
define([
    'jquery',
    'Magento_Ui/js/modal/modal'
], function ($, modal) {
    'use strict';

    return function (config) {
        // Widget code
    };
});
"#;
        let meta = analyzer.analyze(source);
        assert_eq!(meta.module_type, Some("amd".to_string()));
        assert!(meta.define_deps.contains(&"jquery".to_string()));
    }
}

#[cfg(test)]
mod query_tests {
    use super::*;

    #[test]
    fn test_dataobject_set_null_query() {
        let mut analyzer = PhpAstAnalyzer::new().unwrap();
        let source = r#"<?php
class Foo {
    public function bar() {
        $this->setName(null);       // should match
        $this->setBar('value');     // should NOT match (not null)
        $obj->setCouponCode(null);  // should match
        $this->getData();           // should NOT match
    }
}"#;
        let query = include_str!("../queries/dataobject-set-null.scm");
        let results = analyzer.run_query(source, query).unwrap();
        // The query matches ALL member_call_expression with null arg.
        // Post-filter to setX pattern (uppercase after "set").
        let filtered: Vec<_> = results.iter().filter(|r| {
            r.captures.iter().any(|(name, text)| {
                name == "method_name" && text.len() > 3
                    && text.starts_with("set")
                    && text.as_bytes()[3].is_ascii_uppercase()
            })
        }).collect();
        assert_eq!(filtered.len(), 2, "Expected 2 setX(null) matches, got {}: {:?}",
            filtered.len(),
            filtered.iter().map(|r| &r.snippet).collect::<Vec<_>>());
        assert!(filtered[0].snippet.contains("setName(null)"));
        assert!(filtered[1].snippet.contains("setCouponCode(null)"));
    }

    #[test]
    fn test_unchecked_method_chain_query() {
        let mut analyzer = PhpAstAnalyzer::new().unwrap();
        let source = r#"<?php
class Foo {
    private $dep;
    public function bar() {
        $this->dep->doSomething();   // should match
        $this->dep->doAnother();     // should match
        $this->directCall();          // should NOT match
    }
}"#;
        let query = include_str!("../queries/unchecked-method-chain.scm");
        let results = analyzer.run_query(source, query).unwrap();
        assert_eq!(results.len(), 2, "Expected 2 chain matches, got {}: {:?}",
            results.len(),
            results.iter().map(|r| &r.snippet).collect::<Vec<_>>());
        // Verify captures contain expected names
        let first = &results[0];
        let cap_names: Vec<&str> = first.captures.iter().map(|(n, _)| n.as_str()).collect();
        assert!(cap_names.contains(&"root_var"), "Missing root_var capture");
        assert!(cap_names.contains(&"property"), "Missing property capture");
        assert!(cap_names.contains(&"called_method"), "Missing called_method capture");
    }

    #[test]
    fn test_invalid_query() {
        let mut analyzer = PhpAstAnalyzer::new().unwrap();
        let source = "<?php echo 1;";
        let result = analyzer.run_query(source, "(nonexistent_node) @x");
        assert!(result.is_err() || result.unwrap().is_empty());
    }

    #[test]
    fn test_query_line_numbers() {
        let mut analyzer = PhpAstAnalyzer::new().unwrap();
        let source = r#"<?php
// line 2
// line 3
$x->setFoo(null);
// line 5
$y->setBar(null);
"#;
        let query = include_str!("../queries/dataobject-set-null.scm");
        let results = analyzer.run_query(source, query).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].line, 4);
        assert_eq!(results[1].line, 6);
    }
}
