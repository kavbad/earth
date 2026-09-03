# Lessons

Rules distilled from corrections. Review at session start.

- (none yet)
- Workflow scripts are JS template literals: never put inline backticks (`code`) inside an agent prompt; use single quotes. Validate with `node --check` (only the top-level `return` may be reported) before launching.
- The harness's template/scratch database names must carry a run id; anything shared by concurrent test runs (fixed DB names, "drop leftovers" at setup) will destroy a sibling run's state.
