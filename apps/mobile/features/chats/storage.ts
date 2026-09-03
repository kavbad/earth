/**
 * The shell's guarded key-value storage (`lib/storage.ts`: `readJson` / `writeJson` /
 * `createMemoryStorage`), re-exported by a relative path so the pure state modules and their
 * tests resolve it without the `@/` alias. Nothing here imports React Native — the AsyncStorage
 * adapter is `@/lib/deviceStorage`.
 */
export * from '../../lib/storage'
