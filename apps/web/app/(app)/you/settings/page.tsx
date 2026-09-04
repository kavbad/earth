'use client'

/**
 * `/you/settings` — SCREEN 25 index: Account, Privacy, Notifications, Safety, Human identity,
 * then sign out.
 */
import { copy } from '@earth/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/ui/Icon'
import { List, ListRow } from '../../../../components/ui/ListRow'
import { Sheet } from '../../../../components/ui/Sheet'
import { webCopy } from '../../../../lib/copy'
import { useSession } from '../../../../lib/providers/SessionProvider'
import { ROUTES } from '../../../../lib/routes'
import { youCopy } from '../_lib/copy'
import { YOU_ROUTES } from '../_lib/routes'
import { SettingsFrame } from './_components/SettingsFrame'

const SECTIONS = [
  { key: 'account', route: YOU_ROUTES.account },
  { key: 'privacy', route: YOU_ROUTES.privacy },
  { key: 'notifications', route: YOU_ROUTES.notifications },
  { key: 'safety', route: YOU_ROUTES.safety },
  { key: 'humanIdentity', route: YOU_ROUTES.identity },
] as const

export default function SettingsPage() {
  const session = useSession()
  const router = useRouter()
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [busy, setBusy] = useState(false)

  const signOut = async () => {
    setBusy(true)
    try {
      await session.signOut()
      router.push(ROUTES.home)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsFrame title={copy.settings.title} backTo={YOU_ROUTES.you}>
      <List className="py-2">
        {SECTIONS.map((section) => {
          const meta = copy.settings.sections[section.key]
          return (
            <Link key={section.key} href={section.route} className="block">
              <ListRow
                title={meta.title}
                subtitle={Object.values(meta.items).join(' · ')}
                trailing={<Icon name="chevron" size="small" />}
              />
            </Link>
          )
        })}
      </List>
      <div className="px-screen-margin pt-6">
        <Button variant="quiet" onClick={() => setConfirmingSignOut(true)}>
          {webCopy.signOut}
        </Button>
      </div>
      <Sheet
        open={confirmingSignOut}
        onClose={() => setConfirmingSignOut(false)}
        title={youCopy.signOutConfirm}
      >
        <div className="flex flex-col gap-2">
          <Button variant="primary" fullWidth loading={busy} onClick={() => void signOut()}>
            {webCopy.signOut}
          </Button>
          <Button variant="quiet" fullWidth onClick={() => setConfirmingSignOut(false)}>
            {copy.notNow}
          </Button>
        </div>
      </Sheet>
    </SettingsFrame>
  )
}
