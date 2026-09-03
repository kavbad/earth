/**
 * SCREEN 25 → Safety: Blocked Humans (with Unblock) and the report history (spec §81–§82).
 */
import { copy, formatHandle, relativeTime, space, spacing } from '@earth/ui'
import { StyleSheet, Text, View } from 'react-native'

import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { ListRow } from '@/components/ui/ListRow'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusLine } from '@/components/ui/StatusLine'
import { text } from '@/components/ui/text'

import { earthCopy, safetyCopy, youCopy } from '../copy'
import { useBlockedHumans, useReportHistory } from '../hooks/useSafetyLists'
import { type BlockedHuman, type ReportHistoryItem, blockedName } from '../state/safety'
import { SettingsBody, SettingsFrame, SettingsSection, useSettingsBack } from './SettingsFrame'

const items = copy.settings.sections.safety.items

/** `Harassment · Post · Being reviewed · 3 days ago` */
export function reportLine(report: ReportHistoryItem, now: Date = new Date()): string {
  return [
    report.reason !== null && report.reason !== undefined
      ? copy.reportReasons[report.reason]
      : copy.safety.report,
    report.targetType !== null && report.targetType !== undefined
      ? youCopy.reportTargets[report.targetType]
      : null,
    youCopy.reportStatus[report.status],
    relativeTime(report.createdAt, now),
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

function Loading() {
  return (
    <View style={styles.skeleton} accessibilityElementsHidden>
      <Skeleton width="50%" height={space[4]} />
      <Skeleton width="33%" height={space[4]} />
    </View>
  )
}

function blockedSubtitle(block: BlockedHuman): string {
  const handle = block.identity?.handle
  return typeof handle === 'string' && handle.length > 0
    ? formatHandle(handle)
    : relativeTime(block.createdAt)
}

export function SafetySettingsScreen() {
  const back = useSettingsBack()
  const blocks = useBlockedHumans()
  const reports = useReportHistory()

  return (
    <SettingsFrame title={copy.settings.sections.safety.title} onBack={back}>
      <SettingsSection title={items.blockedHumans} hint={safetyCopy.blockGroups}>
        {blocks.blocks === undefined ? (
          blocks.failed ? (
            <StatusLine
              message={copy.couldntRefresh}
              actionLabel={earthCopy.retry}
              onAction={blocks.refetch}
            />
          ) : (
            <Loading />
          )
        ) : blocks.blocks.length === 0 ? (
          <SettingsBody>
            <Text style={[text.secondary, text.muted]}>{youCopy.nobodyBlocked}</Text>
          </SettingsBody>
        ) : (
          blocks.blocks.map((block, index, all) => (
            <ListRow
              key={block.blockedHumanId}
              leading={
                <Avatar
                  name={blockedName(block)}
                  src={block.identity?.avatarUrl ?? null}
                  size="small"
                  decorative
                />
              }
              title={blockedName(block)}
              subtitle={blockedSubtitle(block)}
              separator={index < all.length - 1}
              trailing={
                <Button
                  variant="quiet"
                  compact
                  loading={blocks.unblocking === block.blockedHumanId}
                  label={copy.safety.unblock}
                  onPress={() => void blocks.unblock(block)}
                />
              }
            />
          ))
        )}
      </SettingsSection>
      <SettingsSection title={items.reportHistory}>
        {reports.reports === undefined ? (
          reports.failed ? (
            <StatusLine
              message={copy.couldntRefresh}
              actionLabel={earthCopy.retry}
              onAction={reports.refetch}
            />
          ) : (
            <Loading />
          )
        ) : reports.reports.length === 0 ? (
          <SettingsBody>
            <Text style={[text.secondary, text.muted]}>{youCopy.noReports}</Text>
          </SettingsBody>
        ) : (
          reports.reports.map((report, index, all) => (
            <ListRow
              key={report.id}
              title={
                report.reason !== null && report.reason !== undefined
                  ? copy.reportReasons[report.reason]
                  : copy.safety.report
              }
              subtitle={reportLine(report)}
              separator={index < all.length - 1}
            />
          ))
        )}
      </SettingsSection>
    </SettingsFrame>
  )
}

const styles = StyleSheet.create({
  skeleton: { paddingHorizontal: spacing.screenMargin, gap: space[3] },
})
