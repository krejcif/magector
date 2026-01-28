#!/bin/bash

# Magector Setup Script
# Sets up the MCP server for Claude Code

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "🔧 Magector Setup"
echo "=================="
echo ""

# Check if Claude CLI is available
if ! command -v claude &> /dev/null; then
    echo "⚠️  Claude CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
    echo ""
    echo "Manual setup instructions:"
    echo "Add to your Claude Code settings (~/.claude/settings.json):"
    echo ""
    cat << EOF
{
  "mcpServers": {
    "magector": {
      "command": "node",
      "args": ["$PROJECT_DIR/src/mcp-server.js"],
      "env": {
        "MAGENTO_ROOT": "/path/to/your/magento",
        "MAGECTOR_DB": "$PROJECT_DIR/magector.db"
      }
    }
  }
}
EOF
    exit 0
fi

echo "Found Claude CLI. Adding MCP server..."
echo ""

# Add MCP server to Claude Code
claude mcp add magector node "$PROJECT_DIR/src/mcp-server.js" \
    --env "MAGECTOR_DB=$PROJECT_DIR/magector.db"

echo ""
echo "✅ Magector MCP server added to Claude Code!"
echo ""
echo "Next steps:"
echo "1. Set MAGENTO_ROOT environment variable to your Magento path"
echo "2. Index your Magento codebase: npm run index"
echo "3. Start using in Claude Code - the magecto_* tools are now available"
echo ""
echo "Available MCP tools:"
echo "  - magento_search     : Semantic code search"
echo "  - magento_find_class : Find PHP classes"
echo "  - magento_find_method: Find method implementations"
echo "  - magento_find_config: Find XML configurations"
echo "  - magento_find_template: Find PHTML templates"
echo "  - magento_index      : Re-index codebase"
echo "  - magento_stats      : View index statistics"
