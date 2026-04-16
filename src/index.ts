#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Database } from './db/database.js';
import { IndexHandlers } from './handlers/index-handlers.js';
import { QueryHandlers } from './handlers/query-handlers.js';
import { InspectHandlers } from './handlers/inspect-handlers.js';
import { toolDefs } from './tools/definitions.js';
import { logger } from './utils/logger.js';

async function main() {
  const db = await Database.create();

  const indexHandlers = new IndexHandlers(db);
  const queryHandlers = new QueryHandlers(db);
  const inspectHandlers = new InspectHandlers(db);

  const server = new McpServer(
    { name: 'dep-tracer-mcp-server', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // ── Indexing tools ────────────────────────────────────────────────

  server.registerTool(
    'index_codebase',
    { description: toolDefs.index_codebase.description, inputSchema: toolDefs.index_codebase.schema },
    async (args) => indexHandlers.handleIndexCodebase(args),
  );

  server.registerTool(
    'index_status',
    { description: toolDefs.index_status.description, inputSchema: toolDefs.index_status.schema },
    async (args) => indexHandlers.handleIndexStatus(args),
  );

  // ── Tracing tools ─────────────────────────────────────────────────

  server.registerTool(
    'trace_callees',
    { description: toolDefs.trace_callees.description, inputSchema: toolDefs.trace_callees.schema },
    async (args) => queryHandlers.handleTraceCallees(args),
  );

  server.registerTool(
    'trace_callers',
    { description: toolDefs.trace_callers.description, inputSchema: toolDefs.trace_callers.schema },
    async (args) => queryHandlers.handleTraceCallers(args),
  );

  server.registerTool(
    'trace_module_deps',
    { description: toolDefs.trace_module_deps.description, inputSchema: toolDefs.trace_module_deps.schema },
    async (args) => queryHandlers.handleTraceModuleDeps(args),
  );

  server.registerTool(
    'impact_analysis',
    { description: toolDefs.impact_analysis.description, inputSchema: toolDefs.impact_analysis.schema },
    async (args) => queryHandlers.handleImpactAnalysis(args),
  );

  // ── Inspection tools ──────────────────────────────────────────────

  server.registerTool(
    'get_symbol',
    { description: toolDefs.get_symbol.description, inputSchema: toolDefs.get_symbol.schema },
    async (args) => inspectHandlers.handleGetSymbol(args),
  );

  server.registerTool(
    'get_module_symbols',
    { description: toolDefs.get_module_symbols.description, inputSchema: toolDefs.get_module_symbols.schema },
    async (args) => inspectHandlers.handleGetModuleSymbols(args),
  );

  server.registerTool(
    'search_symbols',
    { description: toolDefs.search_symbols.description, inputSchema: toolDefs.search_symbols.schema },
    async (args) => inspectHandlers.handleSearchSymbols(args),
  );

  server.registerTool(
    'get_test_context',
    { description: toolDefs.get_test_context.description, inputSchema: toolDefs.get_test_context.schema },
    async (args) => inspectHandlers.handleGetTestContext(args),
  );

  // ── Start server ──────────────────────────────────────────────────

  process.on('SIGINT', () => {
    db.close();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Dependency Tracer MCP server running on stdio');
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
