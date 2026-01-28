/**
 * CLAUDE.md section content for Magento projects using Magector.
 */
export const CLAUDE_MD = `# Magector — Magento Semantic Search

This project is indexed with Magector. Use the MCP tools below to search the codebase semantically instead of reading files manually.

## MCP Tools Available

### Search
- \`magento_search\` — Natural language search ("checkout totals calculation", "product price with tier pricing")
- \`magento_find_class\` — Find PHP class/interface/trait by name
- \`magento_find_method\` — Find method implementations across the codebase

### Magento-Specific
- \`magento_find_config\` — Find XML config files (di.xml, events.xml, system.xml)
- \`magento_find_template\` — Find PHTML templates
- \`magento_find_plugin\` — Find interceptor plugins (before/after/around)
- \`magento_find_observer\` — Find event observers
- \`magento_find_preference\` — Find DI preference overrides
- \`magento_find_api\` — Find REST/SOAP API endpoints
- \`magento_find_controller\` — Find controllers by route
- \`magento_find_block\` — Find Block classes
- \`magento_find_cron\` — Find cron job definitions
- \`magento_find_graphql\` — Find GraphQL resolvers and schema
- \`magento_find_db_schema\` — Find database table definitions
- \`magento_module_structure\` — Get full module structure

### Analysis & Utility
- \`magento_index\` — Re-index the codebase after changes
- \`magento_stats\` — View index statistics
- \`magento_analyze_diff\` — Analyze git diffs for risk scoring
- \`magento_complexity\` — Analyze code complexity

## Query Tips

- Describe what code DOES: "calculate product price" not "price file"
- Include Magento terms: "plugin for save", "observer for order place"
- Be specific: "customer address validation before checkout" not just "validation"

## Re-indexing

After significant code changes, re-index:
\`\`\`bash
npx magector index
\`\`\`
`;
