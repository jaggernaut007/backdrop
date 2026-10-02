@import AGENTS.md

## Claude-Specific Behaviours

### Subagent Routing
- Use the Explore subagent for read-only codebase search (5+ query steps)
- Use the Plan subagent before implementing 3+ file changes
- Handle single-file edits directly

### Context Management
- /clear between features (`docs/SPEC.md` is stable; don't re-read on each turn)
- Read `docs/AUDIT-LOG.md` at session start to orient
- Verify against `docs/SPEC.md` scenarios before closing a feature

### Hallucination Prevention
- Pin library versions in all setup queries
- Verify Luma API docs at docs.agents.lumalabs.ai before implementation
- Never invent environment variables; check `.env.example`

### Quality Gates
- Run build + test before committing
- Demo the feature against a real Slack workspace before marking done
- Test mobile UX (the Content Lead's constraint: "works from my phone")

### Code search (Nexus MCP)
- The nexus tools are deferred. Run ToolSearch with `select:mcp__nexus__index,mcp__nexus__search,mcp__nexus__map,mcp__nexus__find_symbol,mcp__nexus__graph,mcp__nexus__explain`.
- At session start, call `index` with the absolute path of the working folder.
- To find files or code, call `search` or `find_symbol` before Grep or Glob. Read only the files that nexus names.
- Before you change a shared symbol, call `graph` with `transitive=true`.
- The current tools are `status`, `index`, `map`, `search`, `find_symbol`, `graph`, `explain`, `analyze`, `memory` and `health`.
