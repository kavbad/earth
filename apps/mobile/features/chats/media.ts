/**
 * Device media for the composer (SCREEN 10 plus sheet → Photo/video; the microphone → voice):
 * picking from the library with `expo-image-picker`, reading a local file into the bytes
 * `media.upload` takes, and the `File` action's availability (a document picker is not part of
 * this build, so the item is hidden until `expo-document-picker` is added).
 */
import * as ImagePicker from 'expo-image-picker'
import { File } from 'expo-file-system'

import { contentTypeForAsset, messageTypeForFile } from './payloads'

export const PICKER_SELECTION_LIMIT = 10
export const PICKER_IMAGE_QUALITY = 0.85

/** `expo-document-picker` is not installed in this build; the plus sheet hides "File". */
export const FILE_PICKER_AVAILABLE = false

export interface PickedMedia {
  readonly uri: string
  readonly contentType: string
  readonly type: 'image' | 'video' | 'file'
  readonly width: number | null
  readonly height: number | null
  readonly durationMs: number | null
  readonly byteSize: number | null
  readonly name: string | null
}

export type PickMediaResult =
  | { readonly status: 'picked'; readonly media: readonly PickedMedia[] }
  | { readonly status: 'cancelled' }
  | { readonly status: 'denied' }

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

export function pickedMediaFromAsset(asset: ImagePicker.ImagePickerAsset): PickedMedia {
  const contentType = contentTypeForAsset(asset)
  return {
    uri: asset.uri,
    contentType,
    type: messageTypeForFile(contentType),
    width: positiveOrNull(asset.width),
    height: positiveOrNull(asset.height),
    durationMs: positiveOrNull(asset.duration),
    byteSize: positiveOrNull(asset.fileSize),
    name: asset.fileName ?? null,
  }
}

/** Opens the photo library for images and videos (several at once). */
export async function pickPhotosAndVideos(): Promise<PickMediaResult> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!permission.granted) return { status: 'denied' }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    allowsMultipleSelection: true,
    selectionLimit: PICKER_SELECTION_LIMIT,
    quality: PICKER_IMAGE_QUALITY,
  })
  if (result.canceled) return { status: 'cancelled' }
  return { status: 'picked', media: result.assets.map(pickedMediaFromAsset) }
}

/** Opens the photo library for one image (a group photo). */
export async function pickOneImage(): Promise<PickMediaResult> {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
  if (!permission.granted) return { status: 'denied' }
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: false,
    allowsEditing: true,
    aspect: [1, 1],
    quality: PICKER_IMAGE_QUALITY,
  })
  if (result.canceled) return { status: 'cancelled' }
  const first = result.assets[0]
  return first === undefined
    ? { status: 'cancelled' }
    : { status: 'picked', media: [pickedMediaFromAsset(first)] }
}

/** The bytes of a local file (`file://` from a picker or a recording) for `media.upload`. */
export async function readFileBody(uri: string): Promise<ArrayBuffer> {
  try {
    return await new File(uri).arrayBuffer()
  } catch {
    const response = await fetch(uri)
    return response.arrayBuffer()
  }
}
