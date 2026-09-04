/**
 * SCREEN 25 → Account: display identity (name, bio, photo), handle (availability shown; changing
 * is not offered yet), access credentials (email / phone, add one by code), recovery (spec §80)
 * and "Delete my account" (a `help` review with `{ action: 'delete' }`, then sign-out).
 */
import { IdentityReviewKinds } from '@earth/auth'
import { BIO_MAX, DISPLAY_NAME_MAX } from '@earth/domain'
import { copy, formatHandle, space } from '@earth/ui'
import * as ImagePicker from 'expo-image-picker'
import { useRouter } from 'expo-router'
import { useEffect, useReducer, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { ListRow } from '@/components/ui/ListRow'
import { Sheet } from '@/components/ui/Sheet'
import { TextField } from '@/components/ui/TextField'

import { earthCopy, youCopy } from '../copy'
import { errorCode, messageForError } from '../errors'
import { lightTap, selectionTap } from '../haptics'
import { HOME_ROUTE } from '../routes'
import { useEarthShell } from '../shell'
import { startCredentialChange, verifyCredentialChange } from '../state/credentials'
import {
  type CredentialMethod,
  DELETE_ACCOUNT_REVIEW,
  OTP_MIN_LENGTH,
  credentialFlowReducer,
  credentialMethod,
  credentialsFrom,
  handleCheckReducer,
  handleNeedsCheck,
  identityFormError,
  identityFormReducer,
  identityUpdatePayload,
  initialCredentialFlow,
  initialHandleCheck,
  initialIdentityForm,
  initialRequestState,
  requestReducer,
} from '../state/settings'
import {
  InlineError,
  Note,
  SettingsBody,
  SettingsFrame,
  SettingsSection,
  StatusText,
  useSettingsBack,
} from './SettingsFrame'

export const HANDLE_CHECK_DEBOUNCE_MS = 400
const PHOTO_QUALITY = 0.85

const items = copy.settings.sections.account.items

/** The bytes of a local `file://` URI for the avatar upload. */
async function readBody(uri: string): Promise<ArrayBuffer> {
  const response = await fetch(uri)
  return response.arrayBuffer()
}

export function AccountSettingsScreen() {
  const shell = useEarthShell()
  const back = useSettingsBack()
  const identity = shell.identity
  return (
    <SettingsFrame title={copy.settings.sections.account.title} onBack={back} avoidKeyboard>
      {identity === null ? null : (
        <>
          <DisplayIdentity
            displayName={identity.displayName}
            bio={identity.bio}
            avatarUrl={identity.avatarUrl}
          />
          <HandleRow current={identity.handle} />
          <AccessCredentials />
          <Recovery />
          <DeleteAccount />
        </>
      )}
    </SettingsFrame>
  )
}

function DisplayIdentity({
  displayName,
  bio,
  avatarUrl,
}: {
  readonly displayName: string
  readonly bio: string | null
  readonly avatarUrl: string | null
}) {
  const shell = useEarthShell()
  const { earth, toast } = shell
  const [form, dispatch] = useReducer(identityFormReducer, undefined, () =>
    initialIdentityForm(displayName, bio),
  )
  const baseline = useRef({ displayName, bio })
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    if (baseline.current.displayName === displayName && baseline.current.bio === bio) return
    baseline.current = { displayName, bio }
    dispatch({ type: 'reset', displayName, bio })
  }, [displayName, bio])

  const validation = identityFormError(form)
  const payload = identityUpdatePayload(form, { displayName, bio })
  const dirty = Object.keys(payload).length > 0

  const save = async () => {
    if (validation !== null || !dirty || form.saving) return
    lightTap()
    dispatch({ type: 'saving' })
    try {
      await earth.identity.update(payload)
      await shell.refreshSession()
      dispatch({ type: 'saved', at: Date.now() })
      toast(youCopy.saved)
    } catch (cause) {
      dispatch({ type: 'failed', error: messageForError(cause) })
    }
  }

  const choosePhoto = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!permission.granted) {
      toast(earthCopy.photosPermission)
      return
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: PHOTO_QUALITY,
    })
    const asset = result.canceled ? undefined : result.assets[0]
    if (asset === undefined) return
    setUploading(true)
    try {
      const media = await earth.identity.uploadAvatar({
        body: await readBody(asset.uri),
        contentType: asset.mimeType ?? 'image/jpeg',
        width: asset.width,
        height: asset.height,
        byteSize: asset.fileSize ?? null,
      })
      await earth.identity.update({ avatarMediaId: media.id })
      await shell.refreshSession()
      toast(youCopy.saved)
    } catch {
      toast(earthCopy.somethingWrong)
    } finally {
      setUploading(false)
    }
  }

  return (
    <SettingsSection title={items.displayIdentity}>
      <SettingsBody>
        <View style={styles.photoRow}>
          <Avatar name={displayName} src={avatarUrl} size="large" decorative />
          <Button
            variant="secondary"
            compact
            loading={uploading}
            label={avatarUrl === null ? earthCopy.choosePhoto : earthCopy.changePhoto}
            onPress={() => void choosePhoto()}
          />
        </View>
        <TextField
          label={copy.displayName}
          value={form.displayName}
          maxLength={DISPLAY_NAME_MAX}
          autoComplete="name"
          textContentType="name"
          onChangeText={(value) => dispatch({ type: 'edit', field: 'displayName', value })}
          hint={earthCopy.displayNameHint}
          error={validation === 'name_required' ? earthCopy.somethingWrong : null}
        />
        <TextField
          label={youCopy.bio}
          value={form.bio}
          maxLength={BIO_MAX}
          onChangeText={(value) => dispatch({ type: 'edit', field: 'bio', value })}
          hint={youCopy.bioHint}
          error={validation === 'bio_too_long' ? earthCopy.somethingWrong : form.error}
        />
        <View style={styles.inline}>
          <Button
            variant="primary"
            loading={form.saving}
            disabled={!dirty || validation !== null}
            label={youCopy.save}
            onPress={() => void save()}
          />
        </View>
      </SettingsBody>
    </SettingsSection>
  )
}

function HandleRow({ current }: { readonly current: string }) {
  const { earth } = useEarthShell()
  const [check, dispatch] = useReducer(handleCheckReducer, current, initialHandleCheck)

  useEffect(() => {
    if (!handleNeedsCheck(check)) return
    const candidate = check.handle
    const timer = setTimeout(() => {
      dispatch({ type: 'checking', handle: candidate })
      earth.identity
        .handleAvailable(candidate)
        .then((available) => dispatch({ type: 'result', handle: candidate, available }))
        .catch(() => dispatch({ type: 'error', handle: candidate }))
    }, HANDLE_CHECK_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [check, earth])

  const trailing =
    check.status === 'checking'
      ? earthCopy.handleChecking
      : check.status === 'available'
        ? earthCopy.handleAvailable
        : check.status === 'taken'
          ? earthCopy.handleTaken
          : check.status === 'same'
            ? youCopy.handleSame
            : check.status === 'invalid'
              ? earthCopy.handleInvalid
              : undefined

  return (
    <SettingsSection title={items.handle} hint={youCopy.handleChangeSoon}>
      <SettingsBody>
        <TextField
          label={copy.handle}
          value={check.input}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(value) => dispatch({ type: 'input', value, current })}
          hint={`${formatHandle(current)} · ${earthCopy.handleHint}`}
          trailing={trailing}
          error={check.status === 'error' ? earthCopy.somethingWrong : null}
        />
      </SettingsBody>
    </SettingsSection>
  )
}

function AccessCredentials() {
  const shell = useEarthShell()
  const { toast, credentialAuth } = shell
  const credentials = credentialsFrom(shell.authSession)
  const [flow, dispatch] = useReducer(credentialFlowReducer, 'email', initialCredentialFlow)
  const [open, setOpen] = useState(false)

  const start = (method: CredentialMethod) => {
    if (credentialAuth === null) {
      toast(youCopy.credentialsUnavailable)
      return
    }
    selectionTap()
    dispatch({ type: 'start', method })
    setOpen(true)
  }

  const send = async () => {
    if (credentialAuth === null || flow.busy) return
    dispatch({ type: 'busy' })
    try {
      await startCredentialChange(credentialAuth, flow.method, flow.destination)
      dispatch({ type: 'sent' })
    } catch (cause) {
      dispatch({ type: 'failed', error: messageForError(cause) })
    }
  }

  const verify = async () => {
    if (credentialAuth === null || flow.busy) return
    lightTap()
    dispatch({ type: 'busy' })
    try {
      await verifyCredentialChange(credentialAuth, flow.method, flow.destination, flow.code)
      await shell.refreshSession()
      dispatch({ type: 'verified' })
      toast(youCopy.credentialAdded)
      setOpen(false)
    } catch (cause) {
      const code = errorCode(cause)
      dispatch({
        type: 'failed',
        error: code === 'invalid_input' ? earthCopy.codeInvalid : messageForError(cause),
      })
    }
  }

  return (
    <SettingsSection title={items.accessCredentials} hint={youCopy.credentials}>
      <ListRow
        title={earthCopy.email}
        subtitle={credentials.email ?? youCopy.noCredential}
        {...(credentials.email === null
          ? {
              trailing: (
                <Button
                  variant="quiet"
                  compact
                  label={youCopy.addEmail}
                  onPress={() => start('email')}
                />
              ),
            }
          : {})}
      />
      <ListRow
        title={earthCopy.phone}
        subtitle={credentials.phone ?? youCopy.noCredential}
        separator={false}
        {...(credentials.phone === null
          ? {
              trailing: (
                <Button
                  variant="quiet"
                  compact
                  label={youCopy.addPhone}
                  onPress={() => start('phone')}
                />
              ),
            }
          : {})}
      />
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={flow.method === 'email' ? youCopy.addEmail : youCopy.addPhone}
        closeButton
        avoidKeyboard
      >
        {flow.step === 'code' ? (
          <View style={styles.stack}>
            <Note>{youCopy.codeSentTo(flow.destination)}</Note>
            <TextField
              label={earthCopy.codeLabel}
              value={flow.code}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              autoFocus
              onChangeText={(value) => dispatch({ type: 'code', value })}
              onSubmitEditing={() => void verify()}
              error={flow.error}
            />
            <Button
              variant="primary"
              fullWidth
              loading={flow.busy}
              disabled={flow.code.trim().length < OTP_MIN_LENGTH}
              label={earthCopy.continue}
              onPress={() => void verify()}
            />
            <Button
              variant="quiet"
              fullWidth
              label={earthCopy.sendAgain}
              onPress={() => dispatch({ type: 'restart' })}
            />
          </View>
        ) : (
          <View style={styles.stack}>
            {flow.method === 'email' ? (
              <TextField
                label={earthCopy.emailLabel}
                value={flow.destination}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                textContentType="emailAddress"
                autoCorrect={false}
                autoFocus
                onChangeText={(value) => dispatch({ type: 'destination', value })}
                onSubmitEditing={() => void send()}
                error={flow.error}
              />
            ) : (
              <TextField
                label={earthCopy.phoneLabel}
                value={flow.destination}
                keyboardType="phone-pad"
                autoComplete="tel"
                textContentType="telephoneNumber"
                autoFocus
                hint={earthCopy.phoneHint}
                onChangeText={(value) => dispatch({ type: 'destination', value })}
                onSubmitEditing={() => void send()}
                error={flow.error}
              />
            )}
            <Button
              variant="primary"
              fullWidth
              loading={flow.busy}
              disabled={flow.destination.trim() === ''}
              label={earthCopy.sendCode}
              onPress={() => void send()}
            />
          </View>
        )}
      </Sheet>
    </SettingsSection>
  )
}

function Recovery() {
  const shell = useEarthShell()
  const { earth, track } = shell
  const [state, dispatch] = useReducer(requestReducer<'recovery'>, undefined, () =>
    initialRequestState<'recovery'>(),
  )

  const start = async () => {
    if (state.busy !== null) return
    lightTap()
    dispatch({ type: 'start', kind: 'recovery' })
    try {
      await earth.claim.createReview({
        kind: IdentityReviewKinds.recovery,
        details: { source: 'settings' },
      })
      track('account_recovery_started', {
        method: credentialMethod(shell.authSession) ?? 'email',
      })
      dispatch({ type: 'done', kind: 'recovery' })
    } catch (cause) {
      dispatch({ type: 'failed', error: messageForError(cause) })
    }
  }

  return (
    <SettingsSection title={items.recovery} hint={youCopy.recoveryLine}>
      <SettingsBody>
        {state.done === 'recovery' ? (
          <StatusText>{youCopy.recoveryRequested}</StatusText>
        ) : (
          <View style={styles.inline}>
            <Button
              variant="secondary"
              loading={state.busy === 'recovery'}
              label={copy.recoverYourPlace}
              onPress={() => void start()}
            />
          </View>
        )}
        <InlineError message={state.error} />
      </SettingsBody>
    </SettingsSection>
  )
}

function DeleteAccount() {
  const shell = useEarthShell()
  const { earth, toast } = shell
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    if (busy) return
    lightTap()
    setBusy(true)
    setError(null)
    try {
      await earth.claim.createReview(DELETE_ACCOUNT_REVIEW)
      await shell.signOut()
      toast(youCopy.deleteRequested)
      setOpen(false)
      router.replace(HOME_ROUTE)
    } catch (cause) {
      setError(messageForError(cause))
      setBusy(false)
    }
  }

  return (
    <SettingsSection title={items.deactivateOrDelete}>
      <SettingsBody>
        <View style={styles.inline}>
          <Button variant="destructive" label={youCopy.deleteTitle} onPress={() => setOpen(true)} />
        </View>
      </SettingsBody>
      <Sheet open={open} onClose={() => setOpen(false)} title={youCopy.deleteTitle}>
        <View style={styles.stack}>
          <StatusText>{youCopy.deleteBody}</StatusText>
          <InlineError message={error} />
          <View style={styles.actions}>
            <Button
              variant="destructive"
              fullWidth
              loading={busy}
              label={youCopy.deleteConfirm}
              onPress={() => void confirm()}
            />
            <Button variant="quiet" fullWidth label={copy.notNow} onPress={() => setOpen(false)} />
          </View>
        </View>
      </Sheet>
    </SettingsSection>
  )
}

const styles = StyleSheet.create({
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: space[4] },
  inline: { flexDirection: 'row' },
  stack: { gap: space[3] },
  actions: { gap: space[2] },
})
