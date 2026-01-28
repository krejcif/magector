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
    if path_lower.contains("/model/") {
        if path_lower.contains("repository") {
            return MagentoFileType::Repository;
        }
        return MagentoFileType::Model;
    }
    if path_lower.contains("graphql") && path_lower.contains("resolver") {
        return MagentoFileType::GraphQlResolver;
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

        meta.is_plugin = !self.plugin_method_re.captures_iter(content).count() == 0;

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

/// XML config analyzer
pub struct XmlAnalyzer {
    preference_re: Regex,
    type_re: Regex,
    plugin_re: Regex,
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
            plugin_re: Regex::new(r#"<plugin\s+name="([^"]+)"\s+type="([^"]+)""#).unwrap(),
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

        // Plugins
        for caps in self.plugin_re.captures_iter(content) {
            meta.plugins.push((caps[1].to_string(), caps[2].to_string()));
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
    pub plugins: Vec<(String, String)>,
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
        for event in &xml.events {
            terms.push(format!("event {}", event.replace('_', " ")));
        }
        for table in &xml.tables {
            terms.push(format!("table {}", table.replace('_', " ")));
        }
    }

    terms.join(" ")
}

fn split_camel_case(s: &str) -> String {
    let mut result = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && c.is_uppercase() {
            result.push(' ');
        }
        result.push(c.to_ascii_lowercase());
    }
    result
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
}
