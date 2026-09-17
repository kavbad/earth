import { describe, expect, it } from 'vitest'

import * as observability from './index'

describe('@earth/observability', () => {
  it('exposes its package name', () => {
    expect(observability.PACKAGE_NAME).toBe('@earth/observability')
  })

  it('exports the logger, monitor, rtc and sentry surfaces from the single entry point', () => {
    expect(typeof observability.createLogger).toBe('function')
    expect(typeof observability.createNoopMonitor).toBe('function')
    expect(typeof observability.createConsoleMonitor).toBe('function')
    expect(typeof observability.createRtcDiagnostics).toBe('function')
    expect(typeof observability.createHttpRtcSink).toBe('function')
    expect(typeof observability.createSentryMonitor).toBe('function')
    expect(typeof observability.buildRelease).toBe('function')
    expect(observability.RTC_DIAGNOSTICS_PATH).toBe('/api/diagnostics/rtc')
  })

  it('exports the redaction and connection-state helpers', () => {
    expect(typeof observability.redactString).toBe('function')
    expect(typeof observability.redactFields).toBe('function')
    expect(typeof observability.scrubRtcDiagnosticEvent).toBe('function')
    expect(typeof observability.diagnosticKindForConnectionState).toBe('function')
    expect(observability.RTC_CONNECTION_STATES).toEqual([
      'connecting',
      'connected',
      'reconnecting',
      'failed',
    ])
  })
})
