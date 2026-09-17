/**
 * Spec §81 controls per target and §82 reasons, rendered on the mobile tree without providers —
 * the counterpart to apps/web's SafetyMenu test.
 */
import { REPORT_REASON, asHumanId, asPostId } from '@earth/domain'
import { copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { safetyCopy } from '@/features/earth/copy'
import { safetyActionsFor } from '@/features/earth/state/safety'
import { render } from '@/test/render'

import { BlockConfirmView } from './BlockConfirm'
import { ReportSheetView } from './ReportSheet'
import { SafetyMenuView } from './SafetyMenu'

const HUMAN = asHumanId('11111111-1111-4111-8111-111111111111')
const POST = asPostId('55555555-5555-4555-8555-555555555555')

const postActions = safetyActionsFor({
  kind: 'post',
  postId: POST,
  authorHumanId: HUMAN,
  authorDisplayName: 'Maya',
})

describe('SafetyMenuView', () => {
  it('renders the given actions as rows and reports which one was pressed', () => {
    const pressed: string[] = []
    const screen = render(
      <SafetyMenuView
        open
        actions={postActions}
        onAction={(key) => pressed.push(key)}
        onClose={() => undefined}
      />,
    )
    expect(screen.text()).toContain(safetyCopy.menuTitle)
    for (const action of postActions) expect(screen.text()).toContain(action.label)
    screen.press(copy.safety.hide)
    expect(pressed).toEqual(['hide'])
  })

  it('surfaces an error to assistive tech and renders nothing while closed', () => {
    const screen = render(
      <SafetyMenuView
        open
        actions={postActions}
        error={safetyCopy.couldnt}
        onAction={() => undefined}
        onClose={() => undefined}
      />,
    )
    const alerts = screen.root.findAll(
      (node) =>
        typeof node.type === 'string' && node.props['accessibilityLiveRegion'] === 'assertive',
    )
    expect(alerts).toHaveLength(1)
    expect(screen.text()).toContain(safetyCopy.couldnt)
    const closed = render(
      <SafetyMenuView
        open={false}
        actions={postActions}
        onAction={() => undefined}
        onClose={() => undefined}
      />,
    )
    expect(closed.renderer.toJSON()).toBeNull()
  })
})

describe('ReportSheetView (spec §82)', () => {
  it('lists the eleven reasons in the spec order', () => {
    const screen = render(
      <ReportSheetView open onReason={() => undefined} onClose={() => undefined} />,
    )
    const text = screen.text()
    const positions = REPORT_REASON.map((reason) => text.indexOf(copy.reportReasons[reason]))
    expect(positions.every((index) => index >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(text).toContain(safetyCopy.reportHint)
  })

  it('hands back the reason that was tapped, and confirms quietly once done', () => {
    const reasons: string[] = []
    const screen = render(
      <ReportSheetView
        open
        onReason={(reason) => reasons.push(reason)}
        onClose={() => undefined}
      />,
    )
    screen.press(copy.reportReasons.harassment)
    expect(reasons).toEqual(['harassment'])
    const done = render(
      <ReportSheetView open done onReason={() => undefined} onClose={() => undefined} />,
    )
    expect(done.text()).toContain(safetyCopy.reportSent)
    expect(done.text()).not.toContain(copy.reportReasons.harassment)
  })
})

describe('BlockConfirmView (spec §56)', () => {
  it('explains group coexistence before blocking', () => {
    let confirmed = 0
    const screen = render(
      <BlockConfirmView
        open
        displayName="Maya"
        onConfirm={() => (confirmed += 1)}
        onClose={() => undefined}
      />,
    )
    expect(screen.text()).toContain(safetyCopy.blockTitle('Maya'))
    expect(screen.text()).toContain(safetyCopy.blockBody('Maya'))
    expect(screen.text()).toContain('you both stay in it')
    screen.press(copy.safety.block)
    expect(confirmed).toBe(1)
  })
})
