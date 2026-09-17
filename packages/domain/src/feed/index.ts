/**
 * Feed: scoring, diversity, deterministic ordering and keyset cursors (ARCHITECTURE §9).
 * Run by the server tier over `feed_candidates` rows; pure and side-effect free.
 */
export * from './weights'
export * from './candidates'
export * from './score'
export * from './cursor'
export * from './rank'
export * from './presence'
