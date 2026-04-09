//! Magento-specific pattern detection and metadata extraction

use regex::Regex;

/// Magento file types
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MagentoFileType {
    Controller,
    Model,
    Repository,
    Plugin,
    Observer,
    Block,
    Helper,
    Api,
    Setup,
    Console,
    Cron,
    GraphQlResolver,
    DiConfig,
    EventsConfig,
    WebapiConfig,
    SystemConfig,
    AclConfig,
    LayoutConfig,
    DbSchema,
    CrontabConfig,
    Template,
    JavaScript,
    GraphQlSchema,
    Other,
}

impl MagentoFileType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Controller => "controller",
            Self::Model => "model",
            Self::Repository => "repository",
            Self::Plugin => "plugin",
            Self::Observer => "observer",
            Self::Block => "block",
            Self::Helper => "helper",
            Self::Api => "api",
            Self::Setup => "setup",
            Self::Console => "console",
            Self::Cron => "cron",
            Self::GraphQlResolver => "graphql_resolver",
            Self::DiConfig => "di_config",
            Self::EventsConfig => "events_config",
            Self::WebapiConfig => "webapi_config",
            Self::SystemConfig => "system_config",
            Self::AclConfig => "acl_config",
            Self::LayoutConfig => "layout_config",
            Self::DbSchema => "db_schema",
            Self::CrontabConfig => "crontab_config",
            Self::Template => "template",
            Self::JavaScript => "javascript",
            Self::GraphQlSchema => "graphql_schema",
            Self::Other => "other",
        }
    }
}

/// Detect Magento file type from path
pub fn detect_file_type(path: &str) -> MagentoFileType {
    let path_lower = path.to_lowercase();

    // XML config files
    if path_lower.ends_with("di.xml") {
        return MagentoFileType::DiConfig;
    }
    if path_lower.ends_with("events.xml") {
        return MagentoFileType::EventsConfig;
    }
    if path_lower.ends_with("webapi.xml") {
        return MagentoFileType::WebapiConfig;
    }
    if path_lower.ends_with("system.xml") {
        return MagentoFileType::SystemConfig;
    }
    if path_lower.ends_with("acl.xml") {
        return MagentoFileType::AclConfig;
    }
    if path_lower.ends_with("crontab.xml") {
        return MagentoFileType::CrontabConfig;
    }
    if path_lower.ends_with("db_schema.xml") {
        return MagentoFileType::DbSchema;
    }
    if path_lower.contains("/layout/") && path_lower.ends_with(".xml") {
        return MagentoFileType::LayoutConfig;
    }

    // PHP files by path
    if path_lower.contains("/controller/") {
        return MagentoFileType::Controller;
    }
    if path_lower.contains("/plugin/") {
        return MagentoFileType::Plugin;
    }
    if path_lower.contains("/observer/") {
        return MagentoFileType::Observer;
    }
    if path_lower.contains("/block/") {
        return MagentoFileType::Block;
    }
    if path_lower.contains("/helper/") {
        return MagentoFileType::Helper;
    }
    if path_lower.contains("/api/") {
        return MagentoFileType::Api;
    }
    if path_lower.contains("/setup/") {
        return MagentoFileType::Setup;
    }
    if path_lower.contains("/console/") {
        return MagentoFileType::Console;
    }
    if path_lower.contains("/cron/") {
        return MagentoFileType::Cron;
    }
    // GraphQL resolver check BEFORE /model/ — resolvers live under
    // Model/Resolver/ in graph-ql modules and would otherwise be classified
    // as plain models.
    if path_lower.contains("resolver") && (path_lower.contains("graph-ql") || path_lower.contains("graphql")) {
        return MagentoFileType::GraphQlResolver;
    }
    if path_lower.contains("/model/") {
        if path_lower.contains("repository") {
            return MagentoFileType::Repository;
        }
        return MagentoFileType::Model;
    }

    // Other file types
    if path_lower.ends_with(".phtml") {
        return MagentoFileType::Template;
    }
    if path_lower.ends_with(".js") {
        return MagentoFileType::JavaScript;
    }
    if path_lower.ends_with(".graphqls") {
        return MagentoFileType::GraphQlSchema;
    }

    MagentoFileType::Other
}

/// Extract module info from path
#[derive(Debug, Clone)]
pub struct ModuleInfo {
    pub vendor: String,
    pub name: String,
    pub full: String,
}

pub fn extract_module_info(path: &str) -> Option<ModuleInfo> {
    // app/code/Vendor/Module/...
    let re = Regex::new(r"app/code/(\w+)/(\w+)").ok()?;
    if let Some(caps) = re.captures(path) {
        return Some(ModuleInfo {
            vendor: caps[1].to_string(),
            name: caps[2].to_string(),
            full: format!("{}_{}", &caps[1], &caps[2]),
        });
    }

    // vendor/vendor-name/module-name/...
    let re = Regex::new(r"vendor/([\w-]+)/([\w-]+)").ok()?;
    if let Some(caps) = re.captures(path) {
        return Some(ModuleInfo {
            vendor: caps[1].to_string(),
            name: caps[2].to_string(),
            full: format!("{}_{}", &caps[1], &caps[2]),
        });
    }

    // lib/internal/Magento/Framework/...
    let re = Regex::new(r"lib/internal/Magento/(\w+)").ok()?;
    if let Some(caps) = re.captures(path) {
        return Some(ModuleInfo {
            vendor: "Magento".to_string(),
            name: caps[1].to_string(),
            full: format!("Magento_{}", &caps[1]),
        });
    }

    None
}

/// Detect area (frontend, adminhtml, etc.)
pub fn detect_area(path: &str) -> Option<String> {
    if path.contains("/frontend/") {
        Some("frontend".to_string())
    } else if path.contains("/adminhtml/") {
        Some("adminhtml".to_string())
    } else if path.contains("/base/") {
        Some("base".to_string())
    } else if path.contains("/webapi_rest/") || path.contains("/webapi_soap/") {
        Some("webapi".to_string())
    } else if path.contains("/graphql/") {
        Some("graphql".to_string())
    } else if path.contains("/crontab/") {
        Some("crontab".to_string())
    } else {
        None
    }
}

/// PHP code analyzer
pub struct PhpAnalyzer {
    class_re: Regex,
    namespace_re: Regex,
    method_re: Regex,
    extends_re: Regex,
    implements_re: Regex,
    use_re: Regex,
    plugin_method_re: Regex,
}

impl PhpAnalyzer {
    pub fn new() -> Self {
        Self {
            class_re: Regex::new(r"(?:abstract\s+)?(?:final\s+)?(?:class|interface|trait)\s+(\w+)")
                .unwrap(),
            namespace_re: Regex::new(r"namespace\s+([\w\\]+)").unwrap(),
            method_re: Regex::new(r"(?:public|private|protected)\s+(?:static\s+)?function\s+(\w+)")
                .unwrap(),
            extends_re: Regex::new(r"extends\s+(\w+)").unwrap(),
            implements_re: Regex::new(r"implements\s+([\w\s,\\]+)").unwrap(),
            use_re: Regex::new(r"use\s+([\w\\]+)").unwrap(),
            plugin_method_re: Regex::new(r"function\s+(before|after|around)(\w+)").unwrap(),
        }
    }

    /// Extract PHP metadata from content
    pub fn analyze(&self, content: &str) -> PhpMetadata {
        let mut meta = PhpMetadata::default();

        // Class name
        if let Some(caps) = self.class_re.captures(content) {
            meta.class_name = Some(caps[1].to_string());
        }

        // Namespace
        if let Some(caps) = self.namespace_re.captures(content) {
            meta.namespace = Some(caps[1].to_string());
        }

        // Methods
        for caps in self.method_re.captures_iter(content) {
            meta.methods.push(caps[1].to_string());
        }

        // Extends
        if let Some(caps) = self.extends_re.captures(content) {
            meta.extends = Some(caps[1].to_string());
        }

        // Implements
        if let Some(caps) = self.implements_re.captures(content) {
            meta.implements = caps[1]
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
        }

        // Uses
        for caps in self.use_re.captures_iter(content) {
            meta.uses.push(caps[1].to_string());
        }

        // Detect patterns
        meta.is_controller = content.contains("implements ActionInterface")
            || content.contains("extends Action")
            || meta.methods.contains(&"execute".to_string());

        meta.is_repository = content.contains("RepositoryInterface")
            || meta.class_name.as_ref().map_or(false, |n| n.contains("Repository"));

        meta.is_plugin = self.plugin_method_re.captures_iter(content).count() > 0;

        meta.is_observer = content.contains("implements ObserverInterface")
            || content.contains("implements Observer");

        meta.is_model = content.contains("extends AbstractModel")
            || content.contains("extends AbstractDb");

        meta.is_block = content.contains("extends Template")
            || content.contains("extends AbstractBlock");

        meta.is_resolver = content.contains("implements ResolverInterface")
            || content.contains("implements BatchResolverInterface");

        // Extract plugin methods
        for caps in self.plugin_method_re.captures_iter(content) {
            meta.plugin_methods.push(PluginMethod {
                method_type: caps[1].to_string(),
                target_method: caps[2].to_string(),
            });
        }

        meta
    }
}

impl Default for PhpAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Default)]
pub struct PhpMetadata {
    pub class_name: Option<String>,
    pub namespace: Option<String>,
    pub methods: Vec<String>,
    pub extends: Option<String>,
    pub implements: Vec<String>,
    pub uses: Vec<String>,
    pub is_controller: bool,
    pub is_repository: bool,
    pub is_plugin: bool,
    pub is_observer: bool,
    pub is_model: bool,
    pub is_block: bool,
    pub is_resolver: bool,
    pub plugin_methods: Vec<PluginMethod>,
}

#[derive(Debug, Clone)]
pub struct PluginMethod {
    pub method_type: String,
    pub target_method: String,
}

/// Structured plugin declaration from di.xml
#[derive(Debug, Clone, Default)]
pub struct PluginDeclaration {
    pub target_class: String,
    pub name: String,
    pub plugin_class: String,
    pub disabled: bool,
    pub sort_order: Option<i32>,
}

/// XML config analyzer
pub struct XmlAnalyzer {
    preference_re: Regex,
    type_re: Regex,
    type_block_re: Regex,
    plugin_in_block_re: Regex,
    event_re: Regex,
    route_re: Regex,
    table_re: Regex,
    job_re: Regex,
}

impl XmlAnalyzer {
    pub fn new() -> Self {
        Self {
            preference_re: Regex::new(r#"<preference\s+for="([^"]+)"\s+type="([^"]+)""#).unwrap(),
            type_re: Regex::new(r#"<type\s+name="([^"]+)""#).unwrap(),
            type_block_re: Regex::new(r#"(?s)<type\s+name="([^"]+)"[^>]*>(.*?)</type>"#).unwrap(),
            plugin_in_block_re: Regex::new(r#"<plugin\s+([^/>]*?)/?>"#).unwrap(),
            event_re: Regex::new(r#"<event\s+name="([^"]+)""#).unwrap(),
            route_re: Regex::new(r#"<route\s+url="([^"]+)"\s+method="([^"]+)""#).unwrap(),
            table_re: Regex::new(r#"<table\s+name="([^"]+)""#).unwrap(),
            job_re: Regex::new(r#"<job\s+name="([^"]+)"\s+instance="([^"]+)""#).unwrap(),
        }
    }

    pub fn analyze(&self, content: &str) -> XmlMetadata {
        let mut meta = XmlMetadata::default();

        // Preferences
        for caps in self.preference_re.captures_iter(content) {
            meta.preferences.push((caps[1].to_string(), caps[2].to_string()));
        }

        // Types
        for caps in self.type_re.captures_iter(content) {
            meta.types.push(caps[1].to_string());
        }

        // Plugins — parse <type name="TargetClass"><plugin name=".." type=".." disabled="true"/></type>
        let attr_re = Regex::new(r#"(\w+)="([^"]*)""#).unwrap();
        for type_caps in self.type_block_re.captures_iter(content) {
            let target_class = type_caps[1].to_string();
            let block_content = &type_caps[2];
            for plugin_caps in self.plugin_in_block_re.captures_iter(block_content) {
                let attrs_str = &plugin_caps[1];
                let mut decl = PluginDeclaration {
                    target_class: target_class.clone(),
                    ..Default::default()
                };
                for attr in attr_re.captures_iter(attrs_str) {
                    match &attr[1] {
                        "name" => decl.name = attr[2].to_string(),
                        "type" => decl.plugin_class = attr[2].to_string(),
                        "disabled" => decl.disabled = &attr[2] == "true",
                        "sortOrder" => decl.sort_order = attr[2].parse().ok(),
                        _ => {}
                    }
                }
                if !decl.name.is_empty() {
                    meta.plugins.push(decl);
                }
            }
        }

        // Events
        for caps in self.event_re.captures_iter(content) {
            meta.events.push(caps[1].to_string());
        }

        // Routes
        for caps in self.route_re.captures_iter(content) {
            meta.routes.push((caps[1].to_string(), caps[2].to_string()));
        }

        // Tables
        for caps in self.table_re.captures_iter(content) {
            meta.tables.push(caps[1].to_string());
        }

        // Cron jobs
        for caps in self.job_re.captures_iter(content) {
            meta.cron_jobs.push((caps[1].to_string(), caps[2].to_string()));
        }

        meta
    }
}

impl Default for XmlAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Default)]
pub struct XmlMetadata {
    pub preferences: Vec<(String, String)>,
    pub types: Vec<String>,
    pub plugins: Vec<PluginDeclaration>,
    pub events: Vec<String>,
    pub routes: Vec<(String, String)>,
    pub tables: Vec<String>,
    pub cron_jobs: Vec<(String, String)>,
}

/// Generate searchable text from code
pub fn generate_search_text(
    _content: &str,
    php_meta: Option<&PhpMetadata>,
    xml_meta: Option<&XmlMetadata>,
) -> String {
    let mut terms = Vec::new();

    if let Some(php) = php_meta {
        if let Some(ref class) = php.class_name {
            terms.push(class.clone());
            // Split CamelCase
            let split = split_camel_case(class);
            terms.push(split);
        }

        for method in &php.methods {
            terms.push(method.clone());
            terms.push(split_camel_case(method));
        }

        if let Some(ref ns) = php.namespace {
            for part in ns.split('\\') {
                terms.push(part.to_lowercase());
            }
        }

        if php.is_controller {
            terms.push("controller action execute request".to_string());
        }
        if php.is_repository {
            terms.push("repository crud getbyid save delete getlist".to_string());
        }
        if php.is_plugin {
            terms.push("plugin interceptor before after around".to_string());
        }
        if php.is_observer {
            terms.push("observer event listener execute".to_string());
        }
        if php.is_model {
            terms.push("model entity abstractmodel".to_string());
        }
        if php.is_block {
            terms.push("block template tohtml render".to_string());
        }
        if php.is_resolver {
            terms.push("resolver graphql mutation query".to_string());
        }
    }

    if let Some(xml) = xml_meta {
        for (from, to) in &xml.preferences {
            terms.push(format!("preference {} {}", from, to));
        }
        for plugin in &xml.plugins {
            terms.push(format!("plugin {} {} {}", plugin.target_class, plugin.name, plugin.plugin_class));
            if plugin.disabled {
                terms.push(format!("disabled plugin {}", plugin.name));
            }
        }
        for event in &xml.events {
            terms.push(format!("event {}", event.replace('_', " ")));
        }
        for table in &xml.tables {
            terms.push(format!("table {}", table.replace('_', " ")));
        }
    }

    terms.join(" ")
}

pub fn split_camel_case(s: &str) -> String {
    let mut result = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && c.is_uppercase() {
            result.push(' ');
        }
        result.push(c.to_ascii_lowercase());
    }
    result
}

/// Metadata extracted from PHP Setup scripts (InstallSchema, UpgradeSchema, data patches)
#[derive(Debug, Clone, Default)]
pub struct SetupMetadata {
    /// Tables created via $setup->newTable() or $connection->newTable()
    pub tables_created: Vec<String>,
    /// Columns added via addColumn() with their target table
    pub columns_added: Vec<(String, String)>,
    /// DB triggers created via TriggerFactory / createTrigger
    pub triggers: Vec<TriggerInfo>,
    /// Tables referenced via $setup->getTable() or raw SQL
    pub table_references: Vec<String>,
}

/// Information about a database trigger found in Setup scripts
#[derive(Debug, Clone)]
pub struct TriggerInfo {
    pub name: String,
    pub table: String,
    pub event: String,
    pub timing: String,
    pub statement: String,
}

/// Analyzer for PHP Setup scripts - detects table creation, triggers, and raw SQL
pub struct SetupAnalyzer {
    get_table_re: Regex,
    trigger_name_re: Regex,
    trigger_table_re: Regex,
    trigger_event_re: Regex,
    trigger_time_re: Regex,
    drop_trigger_re: Regex,
}

impl SetupAnalyzer {
    pub fn new() -> Self {
        Self {
            get_table_re: Regex::new(r#"getTable\s*\(\s*['"](\w+)['"]"#).unwrap(),
            trigger_name_re: Regex::new(r#"setName\s*\(\s*['"]([^'"]+)['"]"#).unwrap(),
            trigger_table_re: Regex::new(r#"setTable\s*\(\s*\$(\w+)"#).unwrap(),
            trigger_event_re: Regex::new(r#"setEvent\s*\([^)]*EVENT_(\w+)"#).unwrap(),
            trigger_time_re: Regex::new(r#"setTime\s*\([^)]*TIME_(\w+)"#).unwrap(),
            drop_trigger_re: Regex::new(r#"dropTrigger\s*\(\s*['"]([^'"]+)['"]"#).unwrap(),
        }
    }

    pub fn analyze(&self, content: &str) -> SetupMetadata {
        let mut meta = SetupMetadata::default();

        // Detect table references via getTable()
        for caps in self.get_table_re.captures_iter(content) {
            let table = caps[1].to_string();
            if !meta.table_references.contains(&table) {
                meta.table_references.push(table);
            }
        }

        // Detect tables created via newTable()
        // Look for patterns like: ->newTable($setup->getTable('tablename')) or ->newTable('tablename')
        let new_table_re = Regex::new(r#"newTable\s*\(\s*(?:\$\w+->getTable\s*\(\s*)?['"](\w+)['"]"#).unwrap();
        for caps in new_table_re.captures_iter(content) {
            let table = caps[1].to_string();
            if !meta.tables_created.contains(&table) {
                meta.tables_created.push(table.clone());
            }
            if !meta.table_references.contains(&table) {
                meta.table_references.push(table);
            }
        }

        // Detect triggers by finding TriggerFactory usage blocks
        if content.contains("TriggerFactory") || content.contains("createTrigger") {
            // Parse trigger blocks: each trigger is setName/setTable/setEvent/setTime/addStatement/createTrigger
            let lines: Vec<&str> = content.lines().collect();
            let mut current_trigger: Option<TriggerInfo> = None;

            for line in &lines {
                // New trigger starts with triggerFactory->create() or similar
                if line.contains("triggerFactory->create()") || line.contains("TriggerFactory") && line.contains("create()") {
                    if let Some(trigger) = current_trigger.take() {
                        if !trigger.name.is_empty() {
                            meta.triggers.push(trigger);
                        }
                    }
                    current_trigger = Some(TriggerInfo {
                        name: String::new(),
                        table: String::new(),
                        event: String::new(),
                        timing: String::new(),
                        statement: String::new(),
                    });
                }

                if let Some(ref mut trigger) = current_trigger {
                    if let Some(caps) = self.trigger_name_re.captures(line) {
                        trigger.name = caps[1].to_string();
                    }
                    if let Some(caps) = self.trigger_event_re.captures(line) {
                        trigger.event = caps[1].to_lowercase();
                    }
                    if let Some(caps) = self.trigger_time_re.captures(line) {
                        trigger.timing = caps[1].to_lowercase();
                    }
                    // Table reference for trigger
                    if line.contains("setTable") {
                        // Try to resolve variable name to table
                        if let Some(caps) = self.trigger_table_re.captures(line) {
                            trigger.table = caps[1].to_string();
                        }
                    }
                    if line.contains("createTrigger") {
                        let t = current_trigger.take().unwrap();
                        if !t.name.is_empty() {
                            meta.triggers.push(t);
                        }
                    }
                }
            }
            // Flush last trigger if not yet pushed
            if let Some(trigger) = current_trigger.take() {
                if !trigger.name.is_empty() {
                    meta.triggers.push(trigger);
                }
            }

            // Also extract SQL from addStatement calls (multiline)
            let stmt_re = Regex::new(r"(?s)addStatement\s*\(\s*'(.*?)'").unwrap();
            for caps in stmt_re.captures_iter(content) {
                let sql = caps[1].to_string();
                // Extract table names from SQL statements
                let sql_table_re = Regex::new(r"(?i)\b(?:from|into|update|join|table)\s+`?(\w+)`?").unwrap();
                for tcaps in sql_table_re.captures_iter(&sql) {
                    let tbl = tcaps[1].to_string();
                    if tbl != "as" && tbl != "set" && tbl != "where" && !meta.table_references.contains(&tbl) {
                        meta.table_references.push(tbl);
                    }
                }
            }

            // Also parse drop triggers
            for caps in self.drop_trigger_re.captures_iter(content) {
                let name = caps[1].to_string();
                // Check if already tracked
                if !meta.triggers.iter().any(|t| t.name == name) {
                    meta.triggers.push(TriggerInfo {
                        name,
                        table: String::new(),
                        event: "dropped".to_string(),
                        timing: String::new(),
                        statement: String::new(),
                    });
                }
            }
        }

        meta
    }
}

impl Default for SetupAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

/// Analyzer for inline SQL references in any PHP file
pub struct SqlReferenceAnalyzer {
    zend_expr_re: Regex,
    raw_query_re: Regex,
    table_name_re: Regex,
    get_table_re: Regex,
}

impl SqlReferenceAnalyzer {
    pub fn new() -> Self {
        Self {
            zend_expr_re: Regex::new(r"(?s)Zend_Db_Expr\s*\(\s*'(.*?)'").unwrap(),
            raw_query_re: Regex::new(r#"(?s)->query\s*\(\s*['"](.+?)['"]"#).unwrap(),
            table_name_re: Regex::new(r"(?i)\b(?:from|into|update|join|table)\s+`?(\w+)`?").unwrap(),
            get_table_re: Regex::new(r#"getTable(?:Name)?\s*\(\s*['"](\w+)['"]"#).unwrap(),
        }
    }

    /// Extract all database table names referenced in PHP code via raw SQL
    pub fn extract_table_references(&self, content: &str) -> Vec<String> {
        let mut tables = Vec::new();
        let sql_keywords: &[&str] = &[
            "as", "set", "where", "and", "or", "not", "null", "true", "false",
            "select", "insert", "update", "delete", "from", "into", "values",
            "group", "order", "having", "limit", "offset", "on", "inner", "left",
            "right", "outer", "cross", "join", "if", "then", "else", "end",
            "when", "case", "new", "old", "main_table", "related",
        ];

        // Extract from Zend_Db_Expr
        for caps in self.zend_expr_re.captures_iter(content) {
            let sql = &caps[1];
            for tcaps in self.table_name_re.captures_iter(sql) {
                let tbl = tcaps[1].to_lowercase();
                if !sql_keywords.contains(&tbl.as_str()) && !tables.contains(&tbl) {
                    tables.push(tbl);
                }
            }
        }

        // Extract from raw query() calls
        for caps in self.raw_query_re.captures_iter(content) {
            let sql = &caps[1];
            for tcaps in self.table_name_re.captures_iter(sql) {
                let tbl = tcaps[1].to_lowercase();
                if !sql_keywords.contains(&tbl.as_str()) && !tables.contains(&tbl) {
                    tables.push(tbl);
                }
            }
        }

        // Extract from getTable('name') / getTableName('name')
        for caps in self.get_table_re.captures_iter(content) {
            let tbl = caps[1].to_lowercase();
            if !tables.contains(&tbl) {
                tables.push(tbl);
            }
        }

        // Also look for ->getTableName('tablename') in connection calls
        let conn_table_re = Regex::new(r#"getConnection\(\).*?getTable(?:Name)?\s*\(\s*['"](\w+)['"]"#).unwrap();
        for caps in conn_table_re.captures_iter(content) {
            let tbl = caps[1].to_lowercase();
            if !tables.contains(&tbl) {
                tables.push(tbl);
            }
        }

        tables
    }
}

impl Default for SqlReferenceAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_file_type() {
        assert_eq!(
            detect_file_type("app/code/Magento/Catalog/Controller/Product/View.php"),
            MagentoFileType::Controller
        );
        assert_eq!(
            detect_file_type("app/code/Magento/Catalog/etc/di.xml"),
            MagentoFileType::DiConfig
        );
        assert_eq!(
            detect_file_type("app/code/Magento/Sales/Observer/OrderPlaced.php"),
            MagentoFileType::Observer
        );
    }

    #[test]
    fn test_detect_graphql_resolver_under_model() {
        // Resolvers under Model/Resolver/ in graph-ql modules must be detected
        // as GraphQlResolver, not Model (regression test for ordering fix)
        assert_eq!(
            detect_file_type("vendor/magento/module-catalog-graph-ql/Model/Resolver/Products.php"),
            MagentoFileType::GraphQlResolver
        );
        assert_eq!(
            detect_file_type("vendor/magento/module-quote-graph-ql/Model/Resolver/Cart.php"),
            MagentoFileType::GraphQlResolver
        );
        // Standalone graphql resolvers (not under Model/) still work
        assert_eq!(
            detect_file_type("vendor/magento/module-catalog-graphql/Resolver/Category.php"),
            MagentoFileType::GraphQlResolver
        );
        // Plain Model/ without graphql context remains Model
        assert_eq!(
            detect_file_type("vendor/magento/module-catalog/Model/Product.php"),
            MagentoFileType::Model
        );
        // Repository under Model/ still detected as Repository
        assert_eq!(
            detect_file_type("vendor/magento/module-catalog/Model/ProductRepository.php"),
            MagentoFileType::Repository
        );
    }

    #[test]
    fn test_extract_module_info() {
        let info = extract_module_info("app/code/Magento/Catalog/Model/Product.php").unwrap();
        assert_eq!(info.vendor, "Magento");
        assert_eq!(info.name, "Catalog");
        assert_eq!(info.full, "Magento_Catalog");
    }

    #[test]
    fn test_split_camel_case() {
        assert_eq!(split_camel_case("ProductRepository"), "product repository");
        assert_eq!(split_camel_case("getById"), "get by id");
    }

    #[test]
    fn test_setup_analyzer_table_creation() {
        let analyzer = SetupAnalyzer::new();
        let content = r#"
        $table = $setup->getConnection()->newTable(
            $setup->getTable('custom_order_tracking')
        )->addColumn('entity_id', Table::TYPE_INTEGER, null, ['identity' => true]);
        $setup->getConnection()->createTable($table);
        "#;
        let meta = analyzer.analyze(content);
        assert!(meta.tables_created.contains(&"custom_order_tracking".to_string()));
        assert!(meta.table_references.contains(&"custom_order_tracking".to_string()));
    }

    #[test]
    fn test_setup_analyzer_get_table_references() {
        let analyzer = SetupAnalyzer::new();
        let content = r#"
        $salesruleTable = $setup->getTable('salesrule');
        $orderedTable = $setup->getTable('salesrule_ordered');
        $connection->addColumn($salesruleTable, 'custom_field', ['type' => Table::TYPE_INTEGER]);
        "#;
        let meta = analyzer.analyze(content);
        assert!(meta.table_references.contains(&"salesrule".to_string()));
        assert!(meta.table_references.contains(&"salesrule_ordered".to_string()));
    }

    #[test]
    fn test_setup_analyzer_trigger_detection() {
        let analyzer = SetupAnalyzer::new();
        let content = r#"
        use Magento\Framework\DB\Ddl\TriggerFactory;

        $insert = $this->triggerFactory->create();
        $insert->setName('order_usage_insert');
        $insert->setTime(\Magento\Framework\DB\Ddl\Trigger::TIME_AFTER);
        $insert->setTable($orderedTable);
        $insert->setEvent(\Magento\Framework\DB\Ddl\Trigger::EVENT_INSERT);
        $insert->addStatement('update salesrule as main SET usage = 0 where main.row_id = new.row_id');
        $setup->getConnection()->dropTrigger($insert->getName());
        $setup->getConnection()->createTrigger($insert);
        "#;
        let meta = analyzer.analyze(content);
        assert!(!meta.triggers.is_empty(), "Should detect at least one trigger");
        let trigger = &meta.triggers[0];
        assert_eq!(trigger.name, "order_usage_insert");
        assert_eq!(trigger.event, "insert");
        assert_eq!(trigger.timing, "after");
    }

    #[test]
    fn test_setup_analyzer_multiple_triggers() {
        let analyzer = SetupAnalyzer::new();
        let content = r#"
        use Magento\Framework\DB\Ddl\TriggerFactory;

        $t1 = $this->triggerFactory->create();
        $t1->setName('trigger_insert');
        $t1->setTime(\Magento\Framework\DB\Ddl\Trigger::TIME_AFTER);
        $t1->setEvent(\Magento\Framework\DB\Ddl\Trigger::EVENT_INSERT);
        $setup->getConnection()->createTrigger($t1);

        $t2 = $this->triggerFactory->create();
        $t2->setName('trigger_update');
        $t2->setTime(\Magento\Framework\DB\Ddl\Trigger::TIME_BEFORE);
        $t2->setEvent(\Magento\Framework\DB\Ddl\Trigger::EVENT_UPDATE);
        $setup->getConnection()->createTrigger($t2);
        "#;
        let meta = analyzer.analyze(content);
        assert_eq!(meta.triggers.len(), 2);
        assert_eq!(meta.triggers[0].name, "trigger_insert");
        assert_eq!(meta.triggers[1].name, "trigger_update");
        assert_eq!(meta.triggers[1].timing, "before");
    }

    #[test]
    fn test_setup_analyzer_sql_table_extraction() {
        let analyzer = SetupAnalyzer::new();
        let content = r#"
        use Magento\Framework\DB\Ddl\TriggerFactory;
        $t = $this->triggerFactory->create();
        $t->setName('delta_trigger');
        $t->addStatement('insert into ordered_delta(row_id,delta) values (new.row_id,new.usage)');
        $setup->getConnection()->createTrigger($t);
        "#;
        let meta = analyzer.analyze(content);
        assert!(meta.table_references.contains(&"ordered_delta".to_string()),
            "Should extract table from SQL in addStatement");
    }

    #[test]
    fn test_sql_reference_analyzer_zend_db_expr() {
        let analyzer = SqlReferenceAnalyzer::new();
        let content = r#"
        $select->joinLeft(
            ['delta_table' => new \Zend_Db_Expr('(SELECT row_id,sum(delta) AS delta FROM salesrule_ordered_delta GROUP BY salesrule_ordered_delta.row_id)')],
            'main_table.row_id = delta_table.row_id',
            ['delta']
        );
        "#;
        let tables = analyzer.extract_table_references(content);
        assert!(tables.contains(&"salesrule_ordered_delta".to_string()),
            "Should extract table from Zend_Db_Expr, got: {:?}", tables);
    }

    #[test]
    fn test_sql_reference_analyzer_raw_query() {
        let analyzer = SqlReferenceAnalyzer::new();
        let content = r#"
        $connection->query('delete from salesrule_ordered_delta');
        "#;
        let tables = analyzer.extract_table_references(content);
        assert!(tables.contains(&"salesrule_ordered_delta".to_string()),
            "Should extract table from raw query, got: {:?}", tables);
    }

    #[test]
    fn test_sql_reference_analyzer_get_table() {
        let analyzer = SqlReferenceAnalyzer::new();
        let content = r#"
        $srOrderedTable = $connection->getTableName('salesrule_ordered');
        $salesOrderTable = $connection->getTable('sales_order');
        "#;
        let tables = analyzer.extract_table_references(content);
        assert!(tables.contains(&"salesrule_ordered".to_string()));
        assert!(tables.contains(&"sales_order".to_string()));
    }

    #[test]
    fn test_sql_reference_analyzer_no_false_positives() {
        let analyzer = SqlReferenceAnalyzer::new();
        let content = r#"
        $this->logger->info('Processing order');
        $result = $this->repository->getById($id);
        "#;
        let tables = analyzer.extract_table_references(content);
        assert!(tables.is_empty(), "Should not extract tables from non-SQL code, got: {:?}", tables);
    }

    #[test]
    fn test_xml_analyzer_plugin_with_target_class() {
        let analyzer = XmlAnalyzer::new();
        let content = r#"
        <config>
            <type name="Magento\SalesRule\Model\Rule\Condition\Address">
                <plugin name="add_grand_total_condition" type="Vendor\Module\Plugin\AddGrandTotalPlugin" />
            </type>
        </config>
        "#;
        let meta = analyzer.analyze(content);
        assert_eq!(meta.plugins.len(), 1);
        let plugin = &meta.plugins[0];
        assert_eq!(plugin.target_class, "Magento\\SalesRule\\Model\\Rule\\Condition\\Address");
        assert_eq!(plugin.name, "add_grand_total_condition");
        assert_eq!(plugin.plugin_class, "Vendor\\Module\\Plugin\\AddGrandTotalPlugin");
        assert!(!plugin.disabled);
    }

    #[test]
    fn test_xml_analyzer_plugin_disabled() {
        let analyzer = XmlAnalyzer::new();
        let content = r#"
        <config>
            <type name="Magento\SalesRule\Model\Rule\Condition\Address">
                <plugin name="add_grand_total_condition" disabled="true" />
            </type>
        </config>
        "#;
        let meta = analyzer.analyze(content);
        assert_eq!(meta.plugins.len(), 1);
        assert!(meta.plugins[0].disabled, "Plugin should be marked as disabled");
        assert_eq!(meta.plugins[0].target_class, "Magento\\SalesRule\\Model\\Rule\\Condition\\Address");
    }

    #[test]
    fn test_xml_analyzer_multiple_plugins_per_type() {
        let analyzer = XmlAnalyzer::new();
        let content = r#"
        <config>
            <type name="Magento\Catalog\Model\Product">
                <plugin name="plugin_one" type="Vendor\A\PluginOne" sortOrder="10" />
                <plugin name="plugin_two" type="Vendor\B\PluginTwo" disabled="true" />
            </type>
        </config>
        "#;
        let meta = analyzer.analyze(content);
        assert_eq!(meta.plugins.len(), 2);
        assert_eq!(meta.plugins[0].name, "plugin_one");
        assert_eq!(meta.plugins[0].sort_order, Some(10));
        assert!(!meta.plugins[0].disabled);
        assert_eq!(meta.plugins[1].name, "plugin_two");
        assert!(meta.plugins[1].disabled);
        // Both should have the same target class
        assert_eq!(meta.plugins[0].target_class, meta.plugins[1].target_class);
    }

    #[test]
    fn test_xml_analyzer_plugins_across_multiple_types() {
        let analyzer = XmlAnalyzer::new();
        let content = r#"
        <config>
            <type name="Magento\Catalog\Model\Product">
                <plugin name="catalog_plugin" type="Vendor\CatalogPlugin" />
            </type>
            <type name="Magento\Sales\Model\Order">
                <plugin name="sales_plugin" type="Vendor\SalesPlugin" />
            </type>
        </config>
        "#;
        let meta = analyzer.analyze(content);
        assert_eq!(meta.plugins.len(), 2);
        assert_eq!(meta.plugins[0].target_class, "Magento\\Catalog\\Model\\Product");
        assert_eq!(meta.plugins[1].target_class, "Magento\\Sales\\Model\\Order");
    }

    #[test]
    fn test_generate_search_text_includes_plugin_target() {
        let xml_meta = XmlMetadata {
            plugins: vec![PluginDeclaration {
                target_class: "Magento\\SalesRule\\Model\\Rule\\Condition\\Address".to_string(),
                name: "add_grand_total".to_string(),
                plugin_class: "Vendor\\Plugin\\AddGrandTotal".to_string(),
                disabled: false,
                sort_order: None,
            }],
            ..Default::default()
        };
        let text = generate_search_text("", None, Some(&xml_meta));
        assert!(text.contains("Magento\\SalesRule\\Model\\Rule\\Condition\\Address"),
            "Search text should contain the target class, got: {}", text);
        assert!(text.contains("add_grand_total"), "Search text should contain plugin name");
    }

    #[test]
    fn test_generate_search_text_disabled_plugin() {
        let xml_meta = XmlMetadata {
            plugins: vec![PluginDeclaration {
                target_class: "Magento\\Catalog\\Model\\Product".to_string(),
                name: "my_plugin".to_string(),
                plugin_class: "Vendor\\Plugin\\MyPlugin".to_string(),
                disabled: true,
                sort_order: None,
            }],
            ..Default::default()
        };
        let text = generate_search_text("", None, Some(&xml_meta));
        assert!(text.contains("disabled plugin my_plugin"),
            "Search text should indicate disabled plugin, got: {}", text);
    }
}
