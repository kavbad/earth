/**
 * Safety controls (spec §81–§82) for every surface: `SafetyMenu` / `SafetyMenuButton` per target
 * (post, profile, room, guest), `ReportSheet` with the exact reasons, `BlockConfirm` with the
 * group-coexistence line. Other agents import from here.
 */
export * from './ReportSheet'
export * from './BlockConfirm'
export * from './SafetyMenu'
export { safetyCopy } from '@/features/earth/copy'
export {
  SAFETY_ACTION_KEYS,
  type SafetyAction,
  type SafetyActionKey,
  type SafetyTarget,
  blockableFor,
  claimEntryFor,
  reportTargetFor,
  safetyActionAllowed,
  safetyActionsFor,
} from '@/features/earth/state/safety'
