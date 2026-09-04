/** The `expo-file-system` test double: a file handle that reads as empty bytes. */
export class File {
  constructor(readonly uri: string) {}
  arrayBuffer(): Promise<ArrayBuffer> {
    return Promise.resolve(new ArrayBuffer(0))
  }
  text(): Promise<string> {
    return Promise.resolve('')
  }
  get exists(): boolean {
    return false
  }
  get size(): number {
    return 0
  }
}

export class Directory {
  constructor(readonly uri: string) {}
}

export const Paths = { cache: { uri: 'file:///cache/' }, document: { uri: 'file:///documents/' } }
