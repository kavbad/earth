/**
 * Incoming system links (spec §112) before expo-router matches them: `/@handle` lands on
 * `/u/<handle>`; `/g/:token`, `/live/:token` and `/p/:postId` are routes of their own.
 */
export { redirectSystemPath } from '@/lib/deeplinks'
