# Lessons

Rules distilled from corrections. Review at session start.

- (none yet)
- Workflow scripts are JS template literals: never put inline backticks (`code`) inside an agent prompt; use single quotes. Validate with `node --check` (only the top-level `return` may be reported) before launching.
- The harness's template/scratch database names must carry a run id; anything shared by concurrent test runs (fixed DB names, "drop leftovers" at setup) will destroy a sibling run's state.
- Adversarial review pays for itself: three private-group-name leaks, a missing signed-media route and three Supabase deploy blockers survived every "green" build and were only found by agents told to construct a bypass, not to confirm the code.
- `renderToStaticMarkup` escapes text; assert against escaped copy (`Couldn&#x27;t`) or the test fails on correct code.
- A file in Next's `public/` shadows a same-path route handler — committed placeholder `.well-known` files silently beat env-driven routes.
- Concurrent test runs sharing one Postgres need a run id in every database name; a fixed template plus "drop leftovers at setup" destroys a sibling run.
- Cross-journey isolation needs random name tails, not sequential ones: trigram search matched two journeys' fixtures that differed by one character.
