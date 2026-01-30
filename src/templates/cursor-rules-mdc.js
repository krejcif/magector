/**
 * .cursor/rules/magector.mdc content for Magento projects using Magector.
 * This is the new Cursor rules format (MDC) that replaces .cursorrules.
 */
export const CURSOR_RULES_MDC = `---
description: Magento 2 semantic code search with Magector MCP tools
globs:
alwaysApply: true
---

# Magento 2 Development Rules (Magector)

## Semantic Search First

Before reading files manually, ALWAYS use Magector MCP tools to find relevant code:

1. \`magento_search\` — Natural language search across the entire codebase
2. \`magento_find_class\` — Find a PHP class, interface, or trait
3. \`magento_find_method\` — Find method implementations
4. \`magento_find_config\` — Find XML configuration (di.xml, events.xml, etc.)
5. \`magento_find_template\` — Find PHTML templates
6. \`magento_find_plugin\` — Find interceptor plugins
7. \`magento_find_observer\` — Find event observers
8. \`magento_find_preference\` — Find DI preference overrides
9. \`magento_find_api\` — Find REST/SOAP API endpoints
10. \`magento_find_controller\` — Find controllers by route
11. \`magento_find_block\` — Find Block classes
12. \`magento_find_cron\` — Find cron job definitions
13. \`magento_find_graphql\` — Find GraphQL resolvers and schema
14. \`magento_find_db_schema\` — Find database table definitions
15. \`magento_module_structure\` — Get full module structure
16. \`magento_index\` — Re-index the codebase
17. \`magento_stats\` — View index statistics
18. \`magento_analyze_diff\` — Analyze git diffs for risk
19. \`magento_complexity\` — Analyze code complexity

## Writing Effective Queries

- Describe what the code DOES, not what it IS: "calculate product price" not "price file"
- Include Magento terms: "plugin for save", "observer for order place", "checkout totals collector"
- Be specific: "customer address validation before checkout" not just "validation"

## Magento Development Patterns

- Always check for existing plugins before modifying core behavior
- Use dependency injection — never instantiate classes with \`new\`
- Prefer interfaces over concrete classes
- Check events.xml for observer hooks before adding plugins
- Use repositories for entity CRUD, not direct model save
- Follow PSR-4 autoloading: Vendor\\\\Module\\\\Path\\\\ClassName
- Use db_schema.xml for database changes, not setup scripts
`;
