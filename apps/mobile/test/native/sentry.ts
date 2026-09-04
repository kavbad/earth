/** The `@sentry/react-native` test double: the monitor wires up, nothing leaves the process. */
export const init = (): void => undefined
export const captureException = (): string => 'test-event-id'
export const captureMessage = (): string => 'test-event-id'
export const setUser = (): void => undefined
export const addBreadcrumb = (): void => undefined
export const setTag = (): void => undefined
export const setContext = (): void => undefined
export const flush = (): Promise<boolean> => Promise.resolve(true)
export const wrap = <T>(component: T): T => component
export const reactNavigationIntegration = () => ({ name: 'ReactNavigation' })
