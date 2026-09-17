/** The `expo-secure-store` test double: an in-memory keychain (nothing under test reads it). */
const store = new Map<string, string>()

export const AFTER_FIRST_UNLOCK = 'AFTER_FIRST_UNLOCK'
export const WHEN_UNLOCKED = 'WHEN_UNLOCKED'
export interface SecureStoreOptions {
  readonly keychainAccessible?: string
  readonly keychainService?: string
}
export const getItemAsync = (key: string): Promise<string | null> =>
  Promise.resolve(store.get(key) ?? null)
export const setItemAsync = (key: string, value: string): Promise<void> => {
  store.set(key, value)
  return Promise.resolve()
}
export const deleteItemAsync = (key: string): Promise<void> => {
  store.delete(key)
  return Promise.resolve()
}
export const isAvailableAsync = (): Promise<boolean> => Promise.resolve(true)
