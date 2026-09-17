'use client'

/**
 * SCREEN 25 → Notifications: the four categories (spec §86), a note that push is delivered by the
 * phone app, and a per-conversation summary that leads to each chat's info screen (SCREEN 12)
 * where mute and notification level live.
 */
import { copy } from '@earth/ui'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'

import { chatCopy } from '../../../../../components/chats/copy'
import { Button } from '../../../../../components/ui/Button'
import { Icon } from '../../../../../components/ui/Icon'
import { List, ListRow } from '../../../../../components/ui/ListRow'
import { Skeleton } from '../../../../../components/ui/Skeleton'
import { webCopy } from '../../../../../lib/copy'
import { useEarth, useRuntime } from '../../../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../../../lib/providers/SessionProvider'
import { youCopy } from '../../_lib/copy'
import { conversationInfoRoute } from '../../_lib/routes'
import { SettingsSection } from './SettingsFrame'

const items = copy.settings.sections.notifications.items
const CATEGORIES = ['messages', 'live', 'social', 'engagement'] as const

export function NotificationSettings() {
  const { runtime } = useRuntime()
  const earth = useEarth()
  const session = useSession()
  const conversations = useQuery({
    queryKey: ['conversations', 'prefs', session.humanId],
    queryFn: () => earth.conversations.list({}),
    enabled: runtime !== null && session.roleKind === 'human',
    staleTime: 60_000,
  })

  return (
    <>
      <p className="px-screen-margin pt-4 text-secondary text-text-secondary">
        {youCopy.webNotificationsNote}
      </p>
      <SettingsSection title={copy.settings.sections.notifications.title}>
        <List>
          {CATEGORIES.map((category) => (
            <ListRow
              key={category}
              title={items[category]}
              subtitle={youCopy.categoryHint[category]}
            />
          ))}
        </List>
      </SettingsSection>
      <SettingsSection title={youCopy.perConversation} hint={youCopy.perConversationHint}>
        {conversations.data === undefined ? (
          conversations.isError ? (
            <div className="flex items-center gap-3 px-screen-margin">
              <p role="status" className="text-secondary text-text-secondary">
                {copy.couldntRefresh}
              </p>
              <Button variant="quiet" onClick={() => void conversations.refetch()}>
                {webCopy.retry}
              </Button>
            </div>
          ) : (
            <div aria-hidden="true" className="flex flex-col gap-3 px-screen-margin">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          )
        ) : conversations.data.conversations.length === 0 ? (
          <p className="px-screen-margin text-secondary text-text-secondary">
            {chatCopy.noChatsYet}
          </p>
        ) : (
          <List>
            {conversations.data.conversations.map((conversation) => (
              <Link
                key={conversation.id}
                href={conversationInfoRoute(conversation.id)}
                className="block"
              >
                <ListRow
                  title={conversation.title}
                  subtitle={youCopy.conversationPrefsLine}
                  trailing={<Icon name="chevron" size="small" />}
                />
              </Link>
            ))}
          </List>
        )}
      </SettingsSection>
    </>
  )
}
