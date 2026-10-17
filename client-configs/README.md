# Client configs

Replace `YOUR-DOMAIN.ngrok-free.app` with your ngrok static domain. **Never commit real tokens.**

| File | Client | Notes |
|---|---|---|
| `claude-code-<role>.json` | Claude Code CLI | Start one session per role: `claude --strict-mcp-config --mcp-config client-configs/claude-code-builder.json`. Tokens come from environment variables `MCP_PLANNER_TOKEN`, `MCP_BUILDER_TOKEN`, `MCP_REVIEWER_TOKEN`. |
| `claude-desktop-mcp-remote.json` | Claude Desktop (via the `mcp-remote` bridge) | Merge into Claude Desktop's config file; one entry per role you want. |
| MCP Inspector | Debugging (not an agent) | `npm run inspector` -> transport "Streamable HTTP", URL `.../mcp`, add header `Authorization: Bearer <token>`. |

Clients change quickly: check your client's current documentation for how to add a remote HTTP MCP server with a custom header.
