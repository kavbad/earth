/** The `expo-image-picker` test double: the picker is always available and always cancelled. */
export const MediaTypeOptions = { All: 'All', Images: 'Images', Videos: 'Videos' } as const
export const UIImagePickerPresentationStyle = { AUTOMATIC: 'automatic' } as const
export interface ImagePickerResult {
  readonly canceled: boolean
  readonly assets: readonly unknown[] | null
}
export const launchImageLibraryAsync = (): Promise<ImagePickerResult> =>
  Promise.resolve({ canceled: true, assets: null })
export const launchCameraAsync = (): Promise<ImagePickerResult> =>
  Promise.resolve({ canceled: true, assets: null })
export const requestMediaLibraryPermissionsAsync = (): Promise<{ granted: boolean }> =>
  Promise.resolve({ granted: true })
export const requestCameraPermissionsAsync = (): Promise<{ granted: boolean }> =>
  Promise.resolve({ granted: true })
