/** The `@react-native-async-storage/async-storage` test double: an in-memory key/value store. */
const store = new Map<string, string>()

const AsyncStorage = {
  getItem: (key: string): Promise<string | null> => Promise.resolve(store.get(key) ?? null),
  setItem: (key: string, value: string): Promise<void> => {
    store.set(key, value)
    return Promise.resolve()
  },
  removeItem: (key: string): Promise<void> => {
    store.delete(key)
    return Promise.resolve()
  },
  clear: (): Promise<void> => {
    store.clear()
    return Promise.resolve()
  },
  getAllKeys: (): Promise<string[]> => Promise.resolve([...store.keys()]),
}

export default AsyncStorage
