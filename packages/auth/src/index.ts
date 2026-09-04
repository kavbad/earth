/**
 * @earth/auth — session helpers, the client-side claim-flow state machine, and the
 * HumanVerificationProvider contract with its mock, manual-review and vendor adapters
 * (ARCHITECTURE §2, §4, §6, §14; spec §15, PART IV, PART XII, §111).
 *
 * Single public entry point of the package.
 */
export const PACKAGE_NAME = '@earth/auth' as const

export * from './verification'
export * from './session'
export * from './claim'
