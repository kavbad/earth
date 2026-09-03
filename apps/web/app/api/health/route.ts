import { NextResponse } from 'next/server'

export const SERVICE_NAME = 'earth-web' as const

export interface HealthResponse {
  ok: true
  service: typeof SERVICE_NAME
}

export const dynamic = 'force-dynamic'

export function GET(): NextResponse<HealthResponse> {
  return NextResponse.json({ ok: true, service: SERVICE_NAME })
}
