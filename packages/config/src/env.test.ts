import { describe, expect, it } from 'vitest'

import {
  APP_ENVS,
  AppEnvs,
  DEFAULT_API_BASE_URL,
  DEFAULT_LIVEKIT_URL,
  DEFAULT_ROOM_GRACE_SECONDS,
  DEFAULT_WEB_ORIGIN,
  describeEnv,
  EnvError,
  HUMAN_VERIFICATION_PROVIDERS,
  HUMAN_VERIFICATION_VENDOR_KEYS,
  HumanVerificationProviders,
  loadPublicEnv,
  loadServerEnv,
  PUBLIC_APP_ENV_VARIABLES,
  PUBLIC_DEVELOPMENT_DEFAULT_KEYS,
  PUBLIC_ENV_KEYS,
  PublicEnvPrefixes,
  PublicEnvSchema,
  publicEnvVariableName,
  SERVER_ENV_KEYS,
  SERVER_SECRET_KEYS,
  ServerEnvSchema,
  SUPABASE_JWT_SECRET_MIN_LENGTH,
} from './env'

const WEB = PublicEnvPrefixes.web
const MOBILE = PublicEnvPrefixes.mobile

/** Minimal valid public source under one prefix. */
function publicSource(prefix: string, overrides: Record<string, string | undefined> = {}) {
  return {
    [`${prefix}SUPABASE_URL`]: 'http://localhost:54321',
    [`${prefix}SUPABASE_ANON_KEY`]: 'anon-key',
    [`${prefix}MAP_STYLE_URL`]: 'https://demotiles.maplibre.org/style.json',
    ...overrides,
  }
}

/** Public source that names real hosts for everything with a development default. */
function deployedPublicSource(prefix: string, overrides: Record<string, string | undefined> = {}) {
  return publicSource(prefix, {
    [`${prefix}API_BASE_URL`]: 'https://earth.social',
    [`${prefix}LIVEKIT_URL`]: 'wss://earth.livekit.cloud',
    [`${prefix}WEB_ORIGIN`]: 'https://earth.social',
    ...overrides,
  })
}

/** Minimal valid server source. */
function serverSource(overrides: Record<string, string | undefined> = {}) {
  return {
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_JWT_SECRET: 's'.repeat(SUPABASE_JWT_SECRET_MIN_LENGTH),
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'secret',
    HUMAN_VERIFICATION_PROVIDER: HumanVerificationProviders.mock,
    INTERNAL_CRON_SECRET: 'cron-secret-0123456789',
    ...overrides,
  }
}

function catchEnvError(fn: () => unknown): EnvError {
  try {
    fn()
  } catch (error) {
    if (error instanceof EnvError) return error
    throw error
  }
  throw new Error('expected an EnvError')
}

const variables = (error: EnvError) => error.issues.map((issue) => issue.variable)

describe('schemas match ARCHITECTURE §14', () => {
  it('lists exactly the public variables', () => {
    expect(PUBLIC_ENV_KEYS).toEqual([
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'API_BASE_URL',
      'LIVEKIT_URL',
      'POSTHOG_KEY',
      'POSTHOG_HOST',
      'SENTRY_DSN',
      'MAP_STYLE_URL',
      'APP_ENV',
      'WEB_ORIGIN',
    ])
  })

  it('lists exactly the server variables (plus APP_ENV for the production rule)', () => {
    expect(SERVER_ENV_KEYS).toEqual([
      'APP_ENV',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_JWT_SECRET',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
      'LIVEKIT_URL',
      'HUMAN_VERIFICATION_PROVIDER',
      'HUMAN_VERIFICATION_VENDOR_URL',
      'HUMAN_VERIFICATION_VENDOR_KEY',
      'HUMAN_VERIFICATION_WEBHOOK_SECRET',
      'EXPO_ACCESS_TOKEN',
      'INTERNAL_CRON_SECRET',
      'POSTHOG_SERVER_KEY',
      'SENTRY_DSN',
      'ROOM_GRACE_SECONDS',
    ])
  })

  it('enumerates app environments and verification providers', () => {
    expect(APP_ENVS).toEqual(['development', 'preview', 'production'])
    expect(HUMAN_VERIFICATION_PROVIDERS).toEqual(['mock', 'manual_review', 'vendor'])
    expect(AppEnvs.production).toBe('production')
    expect(HumanVerificationProviders.manual_review).toBe('manual_review')
  })

  it('uses the documented development defaults', () => {
    expect(DEFAULT_API_BASE_URL).toBe('http://localhost:3000')
    expect(DEFAULT_LIVEKIT_URL).toBe('ws://localhost:7880')
    expect(DEFAULT_WEB_ORIGIN).toBe('http://localhost:3000')
    expect(DEFAULT_ROOM_GRACE_SECONDS).toBe(120)
  })

  it('names the development-only defaults and the public APP_ENV copies', () => {
    expect(PUBLIC_DEVELOPMENT_DEFAULT_KEYS).toEqual(['API_BASE_URL', 'LIVEKIT_URL', 'WEB_ORIGIN'])
    for (const key of PUBLIC_DEVELOPMENT_DEFAULT_KEYS) expect(PUBLIC_ENV_KEYS).toContain(key)
    expect(PUBLIC_APP_ENV_VARIABLES).toEqual(['NEXT_PUBLIC_APP_ENV', 'EXPO_PUBLIC_APP_ENV'])
  })

  it('never defaults the verification provider (mock must be an explicit choice)', () => {
    const error = catchEnvError(() =>
      loadServerEnv(serverSource({ HUMAN_VERIFICATION_PROVIDER: undefined })),
    )
    expect(variables(error)).toEqual(['HUMAN_VERIFICATION_PROVIDER'])
  })
})

describe('loadPublicEnv', () => {
  it('parses a valid source and applies defaults', () => {
    const env = loadPublicEnv(publicSource(WEB), WEB)
    expect(env).toEqual({
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_ANON_KEY: 'anon-key',
      API_BASE_URL: DEFAULT_API_BASE_URL,
      LIVEKIT_URL: DEFAULT_LIVEKIT_URL,
      MAP_STYLE_URL: 'https://demotiles.maplibre.org/style.json',
      APP_ENV: AppEnvs.development,
      WEB_ORIGIN: DEFAULT_WEB_ORIGIN,
    })
  })

  it('keeps explicit values, including optional analytics and Sentry keys', () => {
    const env = loadPublicEnv(
      deployedPublicSource(WEB, {
        [`${WEB}POSTHOG_KEY`]: 'phc_123',
        [`${WEB}POSTHOG_HOST`]: 'https://us.i.posthog.com',
        [`${WEB}SENTRY_DSN`]: 'https://abc123@o1.ingest.sentry.io/42',
        [`${WEB}APP_ENV`]: AppEnvs.production,
      }),
      WEB,
    )
    expect(env.API_BASE_URL).toBe('https://earth.social')
    expect(env.LIVEKIT_URL).toBe('wss://earth.livekit.cloud')
    expect(env.POSTHOG_KEY).toBe('phc_123')
    expect(env.POSTHOG_HOST).toBe('https://us.i.posthog.com')
    expect(env.SENTRY_DSN).toBe('https://abc123@o1.ingest.sentry.io/42')
    expect(env.APP_ENV).toBe(AppEnvs.production)
    expect(env.WEB_ORIGIN).toBe('https://earth.social')
  })

  it('strips the prefix and ignores the other prefix and unprefixed keys', () => {
    const source = {
      ...publicSource(MOBILE),
      [`${MOBILE}API_BASE_URL`]: 'http://192.168.1.20:3000',
      // Must be ignored under EXPO_PUBLIC_:
      [`${WEB}API_BASE_URL`]: 'https://wrong.example',
      API_BASE_URL: 'https://also-wrong.example',
      [`${WEB}APP_ENV`]: 'production',
    }
    const env = loadPublicEnv(source, MOBILE)
    expect(env.API_BASE_URL).toBe('http://192.168.1.20:3000')
    expect(env.APP_ENV).toBe(AppEnvs.development)

    // The web prefix alone is not enough for a mobile load.
    expect(() => loadPublicEnv(publicSource(WEB), MOBILE)).toThrow(EnvError)
  })

  it('builds prefixed variable names', () => {
    expect(publicEnvVariableName('SUPABASE_URL', WEB)).toBe('NEXT_PUBLIC_SUPABASE_URL')
    expect(publicEnvVariableName('SUPABASE_URL', MOBILE)).toBe('EXPO_PUBLIC_SUPABASE_URL')
  })

  it('treats empty and whitespace-only values as unset', () => {
    const env = loadPublicEnv(
      publicSource(WEB, {
        [`${WEB}POSTHOG_KEY`]: '',
        [`${WEB}SENTRY_DSN`]: '   ',
        [`${WEB}API_BASE_URL`]: '',
        [`${WEB}SUPABASE_ANON_KEY`]: '  anon-key  ',
      }),
      WEB,
    )
    expect(env.POSTHOG_KEY).toBeUndefined()
    expect(env.SENTRY_DSN).toBeUndefined()
    expect(env.API_BASE_URL).toBe(DEFAULT_API_BASE_URL)
    expect(env.SUPABASE_ANON_KEY).toBe('anon-key')
  })

  it('normalizes base URLs and rejects non-origin WEB_ORIGIN values', () => {
    const env = loadPublicEnv(
      publicSource(WEB, {
        [`${WEB}SUPABASE_URL`]: 'https://xyz.supabase.co/',
        [`${WEB}API_BASE_URL`]: 'https://earth.social//',
        [`${WEB}WEB_ORIGIN`]: 'https://earth.social/',
      }),
      WEB,
    )
    expect(env.SUPABASE_URL).toBe('https://xyz.supabase.co')
    expect(env.API_BASE_URL).toBe('https://earth.social')
    expect(env.WEB_ORIGIN).toBe('https://earth.social')

    const error = catchEnvError(() =>
      loadPublicEnv(publicSource(WEB, { [`${WEB}WEB_ORIGIN`]: 'https://earth.social/app' }), WEB),
    )
    expect(variables(error)).toEqual(['NEXT_PUBLIC_WEB_ORIGIN'])
  })

  it('canonicalises WEB_ORIGIN like location.origin and refuses credentials, query and fragment', () => {
    const origin = (value: string) =>
      loadPublicEnv(publicSource(WEB, { [`${WEB}WEB_ORIGIN`]: value }), WEB).WEB_ORIGIN
    expect(origin('HTTPS://Earth.Social')).toBe('https://earth.social')
    expect(origin('https://earth.social:443')).toBe('https://earth.social')
    expect(origin('http://localhost:3000/')).toBe('http://localhost:3000')
    expect(origin('http://192.168.1.20:3000')).toBe('http://192.168.1.20:3000')

    for (const bad of [
      'https://earth.social/app/',
      'https://earth.social?x=1',
      'https://earth.social#top',
      'https://user:pw@earth.social',
      'wss://earth.social',
    ]) {
      const error = catchEnvError(() =>
        loadPublicEnv(publicSource(WEB, { [`${WEB}WEB_ORIGIN`]: bad }), WEB),
      )
      expect(variables(error), bad).toEqual(['NEXT_PUBLIC_WEB_ORIGIN'])
    }
  })

  it('rejects non-http SUPABASE_URL and non-ws/http LIVEKIT_URL', () => {
    expect(() =>
      loadPublicEnv(publicSource(WEB, { [`${WEB}SUPABASE_URL`]: 'ftp://x.example' }), WEB),
    ).toThrow(EnvError)
    expect(() =>
      loadPublicEnv(publicSource(WEB, { [`${WEB}LIVEKIT_URL`]: 'ftp://x.example' }), WEB),
    ).toThrow(EnvError)
    expect(
      loadPublicEnv(publicSource(WEB, { [`${WEB}LIVEKIT_URL`]: 'https://x.example' }), WEB)
        .LIVEKIT_URL,
    ).toBe('https://x.example')
  })

  it('refuses the localhost development defaults outside development', () => {
    for (const appEnv of [AppEnvs.preview, AppEnvs.production]) {
      const error = catchEnvError(() =>
        loadPublicEnv(publicSource(WEB, { [`${WEB}APP_ENV`]: appEnv }), WEB),
      )
      expect(variables(error), appEnv).toEqual([
        'NEXT_PUBLIC_API_BASE_URL',
        'NEXT_PUBLIC_LIVEKIT_URL',
        'NEXT_PUBLIC_WEB_ORIGIN',
      ])
      for (const issue of error.issues) {
        expect(issue.message).toContain(`refused when APP_ENV=${appEnv}`)
      }
    }

    // Spelling the default out (with or without a trailing slash) is refused just the same.
    const explicit = catchEnvError(() =>
      loadPublicEnv(
        deployedPublicSource(MOBILE, {
          [`${MOBILE}APP_ENV`]: AppEnvs.production,
          [`${MOBILE}WEB_ORIGIN`]: 'http://localhost:3000/',
        }),
        MOBILE,
      ),
    )
    expect(variables(explicit)).toEqual(['EXPO_PUBLIC_WEB_ORIGIN'])

    // Real hosts pass; development keeps the defaults.
    expect(
      loadPublicEnv(deployedPublicSource(WEB, { [`${WEB}APP_ENV`]: AppEnvs.preview }), WEB).APP_ENV,
    ).toBe(AppEnvs.preview)
    expect(loadPublicEnv(publicSource(WEB), WEB).WEB_ORIGIN).toBe(DEFAULT_WEB_ORIGIN)

    // The schema itself refuses too, so direct users cannot bypass the loader.
    expect(
      PublicEnvSchema.safeParse({
        SUPABASE_URL: 'https://xyz.supabase.co',
        SUPABASE_ANON_KEY: 'anon-key',
        MAP_STYLE_URL: 'https://demotiles.maplibre.org/style.json',
        APP_ENV: AppEnvs.production,
      }).success,
    ).toBe(false)
  })

  it('reports field errors and the development-default rule together, once each', () => {
    const error = catchEnvError(() =>
      loadPublicEnv(
        publicSource(WEB, {
          [`${WEB}SUPABASE_URL`]: 'not a url',
          [`${WEB}APP_ENV`]: AppEnvs.production,
        }),
        WEB,
      ),
    )
    expect(variables(error).sort()).toEqual([
      'NEXT_PUBLIC_API_BASE_URL',
      'NEXT_PUBLIC_LIVEKIT_URL',
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_WEB_ORIGIN',
    ])
  })

  it('throws one EnvError listing every issue with prefixed names', () => {
    const error = catchEnvError(() =>
      loadPublicEnv(
        {
          [`${WEB}SUPABASE_URL`]: 'not a url',
          [`${WEB}APP_ENV`]: 'staging',
          // SUPABASE_ANON_KEY and MAP_STYLE_URL missing
        },
        WEB,
      ),
    )
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('EnvError')
    expect(error.scope).toBe('public')
    expect(variables(error).sort()).toEqual([
      'NEXT_PUBLIC_APP_ENV',
      'NEXT_PUBLIC_MAP_STYLE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'NEXT_PUBLIC_SUPABASE_URL',
    ])
    expect(error.message).toContain('Invalid public environment (4 issues)')
    expect(error.message).toContain('  - NEXT_PUBLIC_SUPABASE_URL:')
  })

  it('accepts process.env-shaped sources', () => {
    const source: NodeJS.ProcessEnv = { ...process.env, ...publicSource(WEB) }
    expect(loadPublicEnv(source, WEB).SUPABASE_ANON_KEY).toBe('anon-key')
  })
})

describe('loadServerEnv', () => {
  it('parses a valid source and applies defaults', () => {
    const env = loadServerEnv(serverSource())
    expect(env).toEqual({
      APP_ENV: AppEnvs.development,
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      SUPABASE_JWT_SECRET: 's'.repeat(SUPABASE_JWT_SECRET_MIN_LENGTH),
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret',
      LIVEKIT_URL: DEFAULT_LIVEKIT_URL,
      HUMAN_VERIFICATION_PROVIDER: HumanVerificationProviders.mock,
      INTERNAL_CRON_SECRET: 'cron-secret-0123456789',
      ROOM_GRACE_SECONDS: DEFAULT_ROOM_GRACE_SECONDS,
    })
  })

  it('parses ROOM_GRACE_SECONDS as whole seconds only', () => {
    const grace = (value: string) => loadServerEnv(serverSource({ ROOM_GRACE_SECONDS: value }))
    expect(grace('300').ROOM_GRACE_SECONDS).toBe(300)
    expect(grace('0').ROOM_GRACE_SECONDS).toBe(0)
    expect(grace(' 45 ').ROOM_GRACE_SECONDS).toBe(45)
    expect(grace('').ROOM_GRACE_SECONDS).toBe(DEFAULT_ROOM_GRACE_SECONDS)
    for (const bad of ['abc', '1.5', '-1', '+5', '0x10', '1e2', '1_000', '99999999999999999999']) {
      const error = catchEnvError(() => grace(bad))
      expect(variables(error), bad).toEqual(['ROOM_GRACE_SECONDS'])
    }
    // Used directly, the schema must never turn an empty value into a zero grace period.
    const direct = ServerEnvSchema.safeParse(serverSource({ ROOM_GRACE_SECONDS: '' }))
    expect(direct.success).toBe(false)
  })

  it('refuses HUMAN_VERIFICATION_PROVIDER=mock when APP_ENV=production', () => {
    const error = catchEnvError(() =>
      loadServerEnv(
        serverSource({
          APP_ENV: AppEnvs.production,
          HUMAN_VERIFICATION_PROVIDER: HumanVerificationProviders.mock,
        }),
      ),
    )
    expect(error.scope).toBe('server')
    expect(error.issues).toHaveLength(1)
    expect(error.issues[0]?.variable).toBe('HUMAN_VERIFICATION_PROVIDER')
    expect(error.issues[0]?.message).toContain('refused when APP_ENV=production')

    // The schema itself refuses too, so direct users cannot bypass the loader.
    expect(
      ServerEnvSchema.safeParse(
        serverSource({ APP_ENV: AppEnvs.production, HUMAN_VERIFICATION_PROVIDER: 'mock' }),
      ).success,
    ).toBe(false)
  })

  it('allows mock outside production and manual_review in production', () => {
    for (const appEnv of [AppEnvs.development, AppEnvs.preview]) {
      expect(
        loadServerEnv(serverSource({ APP_ENV: appEnv, HUMAN_VERIFICATION_PROVIDER: 'mock' }))
          .APP_ENV,
      ).toBe(appEnv)
    }
    const production = loadServerEnv(
      serverSource({
        APP_ENV: AppEnvs.production,
        HUMAN_VERIFICATION_PROVIDER: HumanVerificationProviders.manual_review,
      }),
    )
    expect(production.HUMAN_VERIFICATION_PROVIDER).toBe(HumanVerificationProviders.manual_review)
  })

  it('takes APP_ENV from its public copies when the unprefixed variable is unset', () => {
    // A deployment that only set NEXT_PUBLIC_APP_ENV=production must not get the mock verifier.
    const viaWeb = catchEnvError(() =>
      loadServerEnv({ ...serverSource(), NEXT_PUBLIC_APP_ENV: AppEnvs.production }),
    )
    expect(variables(viaWeb)).toEqual(['HUMAN_VERIFICATION_PROVIDER'])
    expect(viaWeb.issues[0]?.message).toContain('refused when APP_ENV=production')

    const viaMobile = loadServerEnv({
      ...serverSource({ HUMAN_VERIFICATION_PROVIDER: HumanVerificationProviders.manual_review }),
      EXPO_PUBLIC_APP_ENV: AppEnvs.production,
    })
    expect(viaMobile.APP_ENV).toBe(AppEnvs.production)

    expect(loadServerEnv({ ...serverSource(), NEXT_PUBLIC_APP_ENV: AppEnvs.preview }).APP_ENV).toBe(
      AppEnvs.preview,
    )

    // An invalid public copy is reported under the name that carried it.
    const invalid = catchEnvError(() =>
      loadServerEnv({ ...serverSource(), NEXT_PUBLIC_APP_ENV: 'staging' }),
    )
    expect(variables(invalid)).toEqual(['NEXT_PUBLIC_APP_ENV'])
  })

  it('refuses an APP_ENV that disagrees with its public copies', () => {
    const disagree = catchEnvError(() =>
      loadServerEnv({
        ...serverSource({ APP_ENV: AppEnvs.development }),
        NEXT_PUBLIC_APP_ENV: AppEnvs.production,
      }),
    )
    expect(variables(disagree)).toEqual(['APP_ENV'])
    expect(disagree.issues[0]?.message).toBe(
      '"development" (from APP_ENV) disagrees with NEXT_PUBLIC_APP_ENV="production"',
    )

    const publicCopiesDisagree = catchEnvError(() =>
      loadServerEnv({
        ...serverSource({ HUMAN_VERIFICATION_PROVIDER: HumanVerificationProviders.manual_review }),
        NEXT_PUBLIC_APP_ENV: AppEnvs.production,
        EXPO_PUBLIC_APP_ENV: AppEnvs.development,
      }),
    )
    expect(publicCopiesDisagree.issues).toEqual([
      {
        variable: 'APP_ENV',
        message:
          '"production" (from NEXT_PUBLIC_APP_ENV) disagrees with EXPO_PUBLIC_APP_ENV="development"',
      },
    ])

    const agree = loadServerEnv({
      ...serverSource({
        APP_ENV: AppEnvs.production,
        HUMAN_VERIFICATION_PROVIDER: HumanVerificationProviders.manual_review,
      }),
      NEXT_PUBLIC_APP_ENV: AppEnvs.production,
      EXPO_PUBLIC_APP_ENV: AppEnvs.production,
    })
    expect(agree.APP_ENV).toBe(AppEnvs.production)
  })

  it('requires vendor settings when the provider is vendor', () => {
    const error = catchEnvError(() =>
      loadServerEnv(
        serverSource({ HUMAN_VERIFICATION_PROVIDER: HumanVerificationProviders.vendor }),
      ),
    )
    expect(variables(error)).toEqual([...HUMAN_VERIFICATION_VENDOR_KEYS])

    const env = loadServerEnv(
      serverSource({
        APP_ENV: AppEnvs.production,
        HUMAN_VERIFICATION_PROVIDER: HumanVerificationProviders.vendor,
        HUMAN_VERIFICATION_VENDOR_URL: 'https://verify.example/v1/',
        HUMAN_VERIFICATION_VENDOR_KEY: 'vendor-key',
        HUMAN_VERIFICATION_WEBHOOK_SECRET: 'webhook-secret',
      }),
    )
    expect(env.HUMAN_VERIFICATION_VENDOR_URL).toBe('https://verify.example/v1')
  })

  it('enforces secret minimum lengths and rejects unknown providers', () => {
    const error = catchEnvError(() =>
      loadServerEnv(
        serverSource({
          SUPABASE_JWT_SECRET: 'short',
          INTERNAL_CRON_SECRET: 'short',
          HUMAN_VERIFICATION_PROVIDER: 'none',
        }),
      ),
    )
    expect(variables(error).sort()).toEqual([
      'HUMAN_VERIFICATION_PROVIDER',
      'INTERNAL_CRON_SECRET',
      'SUPABASE_JWT_SECRET',
    ])
  })

  it('reports field errors and the production rule together', () => {
    const error = catchEnvError(() =>
      loadServerEnv(
        serverSource({
          APP_ENV: AppEnvs.production,
          HUMAN_VERIFICATION_PROVIDER: HumanVerificationProviders.mock,
          LIVEKIT_URL: 'nope',
          SUPABASE_SERVICE_ROLE_KEY: undefined,
        }),
      ),
    )
    expect(variables(error).sort()).toEqual([
      'HUMAN_VERIFICATION_PROVIDER',
      'LIVEKIT_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
    ])
    expect(error.message.split('\n')).toHaveLength(4)
  })

  it('ignores public and unrelated variables in the source', () => {
    const env = loadServerEnv({
      ...serverSource(),
      NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/earth_local',
    })
    expect(
      Object.keys(env).every((key) => (SERVER_ENV_KEYS as readonly string[]).includes(key)),
    ).toBe(true)
  })
})

describe('describeEnv', () => {
  it('lists every variable of both schemas in order', () => {
    const description = describeEnv()
    expect(description.publicPrefixes).toEqual(['NEXT_PUBLIC_', 'EXPO_PUBLIC_'])
    expect(description.public.map((v) => v.name)).toEqual([...PUBLIC_ENV_KEYS])
    expect(description.server.map((v) => v.name)).toEqual([...SERVER_ENV_KEYS])
    for (const doc of [...description.public, ...description.server]) {
      expect(doc.description.length).toBeGreaterThan(10)
    }
  })

  it('derives required flags and defaults from the schemas', () => {
    const { public: pub, server } = describeEnv()
    const byName = (docs: typeof pub, name: string) => docs.find((doc) => doc.name === name)

    expect(byName(pub, 'SUPABASE_URL')).toMatchObject({ required: true, defaultValue: undefined })
    expect(byName(pub, 'POSTHOG_KEY')).toMatchObject({ required: false, defaultValue: undefined })
    expect(byName(pub, 'API_BASE_URL')).toMatchObject({
      required: false,
      defaultValue: DEFAULT_API_BASE_URL,
    })
    expect(byName(pub, 'WEB_ORIGIN')).toMatchObject({
      required: false,
      defaultValue: DEFAULT_WEB_ORIGIN,
    })
    expect(byName(pub, 'APP_ENV')).toMatchObject({ required: false, defaultValue: 'development' })
    expect(byName(server, 'ROOM_GRACE_SECONDS')).toMatchObject({
      required: false,
      defaultValue: '120',
    })
    expect(byName(server, 'HUMAN_VERIFICATION_PROVIDER')).toMatchObject({ required: true })
    expect(pub.every((doc) => !doc.secret)).toBe(true)
    expect(server.filter((doc) => doc.secret).map((doc) => doc.name)).toEqual([
      ...SERVER_SECRET_KEYS,
    ])
  })

  it('agrees with the schemas about what is required', () => {
    const required = describeEnv()
      .public.filter((doc) => doc.required)
      .map((doc) => doc.name)
    const result = PublicEnvSchema.safeParse({})
    expect(result.success).toBe(false)
    const failing = result.error?.issues.map((issue) => String(issue.path[0])).sort()
    expect(failing).toEqual([...required].sort())
  })

  it('documents the development-only defaults as such', () => {
    const { public: pub } = describeEnv()
    for (const doc of pub) {
      const developmentOnly = (PUBLIC_DEVELOPMENT_DEFAULT_KEYS as readonly string[]).includes(
        doc.name,
      )
      expect(doc.description.includes('Default applies only when APP_ENV=development')).toBe(
        developmentOnly,
      )
    }
  })
})
