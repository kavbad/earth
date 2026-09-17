import { JoinEntry } from '../_components/JoinEntry'

type SearchParams = Promise<{ readonly token?: string | string[] | undefined }>

/** Spec §46: `/claim/join?token=…` hands the invite to the claim machine and continues to the credential. */
export default async function ClaimJoinPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const raw = params.token
  const token = Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null)
  return <JoinEntry token={token} />
}
