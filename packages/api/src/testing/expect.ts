/**
 * Assertion helper shared by the client tests: awaits a rejection and returns the `EarthError`.
 */
import { EarthError } from '@earth/domain'

export async function earthRejection(promise: Promise<unknown>): Promise<EarthError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof EarthError) return error
    throw error
  }
  throw new Error('expected the promise to reject with an EarthError')
}
