/**
 * Spec §45 step 5: public identity — display name required, handle auto-suggested and editable,
 * profile photo optional (from the library through `expo-image-picker`, uploaded to the avatars
 * bucket). Nothing here is Human Pass data (spec §17, §78).
 */
import {
  DISPLAY_NAME_MAX,
  HANDLE_MAX_LENGTH,
  handleCandidates,
  isValidHandle,
  normalizeHandle,
} from '@earth/domain'
import { copy, space } from '@earth/ui'
import * as ImagePicker from 'expo-image-picker'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { useClaimFlow } from '@/components/claim/ClaimFlowProvider'
import { ClaimBody, ClaimFrame, ClaimTitle } from '@/components/claim/ClaimFrame'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/TextField'
import { text } from '@/components/ui/text'
import { shellCopy } from '@/lib/copy'
import { errorCode } from '@/lib/errors'
import { lightTap } from '@/lib/haptics'
import { useEarth, useToast } from '@/lib/providers'

type CheckStatus = 'idle' | 'checking' | 'available' | 'taken'

interface Photo {
  readonly uri: string
  readonly contentType: string
  readonly width: number | undefined
  readonly height: number | undefined
  readonly byteSize: number | undefined
}

const SUGGESTION_ATTEMPTS = 5
const CHECK_DEBOUNCE_MS = 300
const PHOTO_QUALITY = 0.85

async function readBody(uri: string): Promise<ArrayBuffer> {
  const response = await fetch(uri)
  return response.arrayBuffer()
}

export default function ClaimIdentityScreen() {
  const { dispatch } = useClaimFlow()
  const earth = useEarth()
  const toast = useToast()
  const [displayName, setDisplayName] = useState('')
  /** What the person typed into the handle field; `null` until they edit the suggestion. */
  const [typed, setTyped] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState('')
  const [check, setCheck] = useState<{ readonly handle: string; readonly status: CheckStatus }>({
    handle: '',
    status: 'idle',
  })
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ticket = useRef(0)

  const name = displayName.trim()
  const handle = typed ?? (name === '' ? '' : suggestion)
  const normalized = normalizeHandle(handle)
  const syntaxError = normalized !== '' && !isValidHandle(normalized)
  const status: CheckStatus =
    normalized === '' || syntaxError || check.handle !== normalized ? 'idle' : check.status

  // Suggest a handle from the display name until the person edits it (spec §45 step 5).
  useEffect(() => {
    if (typed !== null || name === '') return
    const mine = ++ticket.current
    const timer = setTimeout(async () => {
      for (const candidate of handleCandidates(name, SUGGESTION_ATTEMPTS)) {
        if (mine !== ticket.current) return
        setSuggestion(candidate)
        setCheck({ handle: candidate, status: 'checking' })
        const free = await earth.identity.handleAvailable(candidate).catch(() => false)
        if (mine !== ticket.current) return
        if (free) {
          setCheck({ handle: candidate, status: 'available' })
          return
        }
        setCheck({ handle: candidate, status: 'taken' })
      }
    }, CHECK_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [name, typed, earth])

  // Check an edited handle.
  useEffect(() => {
    if (typed === null) return
    const candidate = normalizeHandle(typed)
    if (candidate === '' || !isValidHandle(candidate)) return
    const mine = ++ticket.current
    const timer = setTimeout(async () => {
      setCheck({ handle: candidate, status: 'checking' })
      const free = await earth.identity.handleAvailable(candidate).catch(() => false)
      if (mine === ticket.current)
        setCheck({ handle: candidate, status: free ? 'available' : 'taken' })
    }, CHECK_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [typed, earth])

  const choosePhoto = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!permission.granted) {
      toast.show(shellCopy.photoPermission)
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
    setPhoto({
      uri: asset.uri,
      contentType: asset.mimeType ?? 'image/jpeg',
      width: asset.width,
      height: asset.height,
      byteSize: asset.fileSize ?? undefined,
    })
  }

  const onSubmit = async () => {
    if (name === '' || !isValidHandle(normalized)) return
    lightTap()
    setBusy(true)
    setError(null)
    try {
      let avatarMediaId: string | null = null
      if (photo !== null) {
        const uploaded = await earth.identity.uploadAvatar({
          body: await readBody(photo.uri),
          contentType: photo.contentType,
          ...(photo.width === undefined ? {} : { width: photo.width }),
          ...(photo.height === undefined ? {} : { height: photo.height }),
          ...(photo.byteSize === undefined ? {} : { byteSize: photo.byteSize }),
        })
        avatarMediaId = uploaded.id
      }
      await earth.claim.setIdentity({ displayName: name, handle: normalized, avatarMediaId })
      dispatch({ type: 'identitySet' })
    } catch (cause) {
      const code = errorCode(cause)
      if (code === 'handle_taken') {
        setTyped(handle)
        setCheck({ handle: normalized, status: 'taken' })
      } else if (code === 'handle_invalid') {
        setTyped(handle)
        setError(shellCopy.handleInvalid)
      } else {
        setError(shellCopy.somethingWrong)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleTrailing =
    status === 'checking'
      ? shellCopy.handleChecking
      : status === 'available'
        ? shellCopy.handleAvailable
        : undefined
  const handleError = syntaxError
    ? shellCopy.handleInvalid
    : status === 'taken'
      ? shellCopy.handleTaken
      : null
  const canSubmit = name !== '' && status === 'available' && !busy

  return (
    <ClaimFrame>
      <ClaimTitle>{copy.displayName}</ClaimTitle>
      <View style={styles.form}>
        <TextField
          label={copy.displayName}
          hint={shellCopy.displayNameHint}
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={DISPLAY_NAME_MAX}
          autoComplete="name"
          textContentType="name"
          autoFocus
          returnKeyType="next"
        />
        <TextField
          label={copy.handle}
          hint={shellCopy.handleHint}
          value={handle}
          onChangeText={setTyped}
          maxLength={HANDLE_MAX_LENGTH + 1}
          autoCapitalize="none"
          autoCorrect={false}
          trailing={handleTrailing}
          error={handleError}
        />
        <View style={styles.photoRow}>
          <Avatar
            name={name === '' ? copy.human : name}
            src={photo?.uri ?? null}
            size="large"
            decorative
          />
          <View style={styles.photoActions}>
            <Text style={[text.secondary, text.muted]}>
              {copy.profilePhoto} · {shellCopy.photoOptional}
            </Text>
            <View style={styles.photoButtons}>
              <Button
                variant="secondary"
                compact
                label={photo === null ? shellCopy.choosePhoto : shellCopy.changePhoto}
                accessibilityLabel={copy.profilePhoto}
                onPress={() => void choosePhoto()}
              />
              {photo !== null ? (
                <Button
                  variant="quiet"
                  compact
                  label={shellCopy.removePhoto}
                  onPress={() => setPhoto(null)}
                />
              ) : null}
            </View>
          </View>
        </View>
        {error !== null ? <ClaimBody danger>{error}</ClaimBody> : null}
        <Button
          variant="primary"
          fullWidth
          loading={busy}
          disabled={!canSubmit}
          label={shellCopy.continue}
          onPress={() => void onSubmit()}
        />
      </View>
    </ClaimFrame>
  )
}

const styles = StyleSheet.create({
  form: { gap: space[4] },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: space[4] },
  photoActions: { flex: 1, gap: space[1] },
  photoButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2] },
})
