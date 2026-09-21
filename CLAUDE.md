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
