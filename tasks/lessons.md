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
- A test must never hardcode a fact about the machine it happens to run on. `helpers.test.ts` asserted the Postgres socket peer was `127.0.0.1`, which is true locally and false in CI (the client crosses a Docker bridge, so the peer is the gateway, `172.18.0.1`). Read the environment fact from the environment (`host(inet_client_addr())`) and assert against that — the assertion gets stronger, not weaker.
- When a CI job is red and its log is unreadable, fixing the readability is a real step, but say plainly that the failure itself is still unfixed rather than reporting the log fix as progress on the failure.
- A workflow-level `env:` block reaches every job. CI's placeholder Supabase keys (there so the build jobs have a well-shaped environment) silently overrode the real local-stack keys in the e2e job, because the stack suite resolves configuration from `process.env` first. When two steps in a job need different environments, the one that needs the real values must load them explicitly — and assert early that they agree, so the mismatch is named rather than surfacing as a signature error three tests later.
