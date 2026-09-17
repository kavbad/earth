import { BIO_MAX, DISPLAY_NAME_MAX } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  DELETE_ACCOUNT_REVIEW,
  credentialFlowReducer,
  credentialsFrom,
  handleCheckReducer,
  handleNeedsCheck,
  identityFormError,
  identityFormReducer,
  identityUpdatePayload,
  initialCredentialFlow,
  initialHandleCheck,
  initialIdentityForm,
} from './settings'

describe('display identity form', () => {
  it('tracks edits, saving and errors', () => {
    let form = initialIdentityForm('Maya', null)
    form = identityFormReducer(form, { type: 'edit', field: 'bio', value: 'Hi' })
    expect(form.bio).toBe('Hi')
    form = identityFormReducer(form, { type: 'saving' })
    expect(form.saving).toBe(true)
    form = identityFormReducer(form, { type: 'saved', at: 5 })
    expect(form).toMatchObject({ saving: false, savedAt: 5 })
    form = identityFormReducer(form, { type: 'failed', error: 'nope' })
    expect(form).toMatchObject({ saving: false, error: 'nope' })
  })

  it('validates name and bio lengths', () => {
    expect(identityFormError({ displayName: ' ', bio: '' })).toBe('name_required')
    expect(identityFormError({ displayName: 'x'.repeat(DISPLAY_NAME_MAX + 1), bio: '' })).toBe(
      'name_too_long',
    )
    expect(identityFormError({ displayName: 'Maya', bio: 'x'.repeat(BIO_MAX + 1) })).toBe(
      'bio_too_long',
    )
    expect(identityFormError({ displayName: 'Maya', bio: '' })).toBeNull()
  })

  it('sends only the fields that changed', () => {
    expect(
      identityUpdatePayload({ displayName: 'Maya', bio: '' }, { displayName: 'Maya', bio: null }),
    ).toEqual({})
    expect(
      identityUpdatePayload(
        { displayName: ' Maya R ', bio: 'Hi' },
        { displayName: 'Maya', bio: null },
      ),
    ).toEqual({
      displayName: 'Maya R',
      bio: 'Hi',
    })
  })
})

describe('handle availability machine', () => {
  it('normalizes input, recognizes the own handle and invalid candidates', () => {
    let state = initialHandleCheck('maya')
    expect(state.status).toBe('same')
    state = handleCheckReducer(state, { type: 'input', value: '@Maya', current: 'maya' })
    expect(state).toMatchObject({ handle: 'maya', status: 'same' })
    state = handleCheckReducer(state, { type: 'input', value: 'ma', current: 'maya' })
    expect(state.status).toBe('invalid')
    state = handleCheckReducer(state, { type: 'input', value: 'Maya_2', current: 'maya' })
    expect(state).toMatchObject({ handle: 'maya_2', status: 'idle' })
    expect(handleNeedsCheck(state)).toBe(true)
  })

  it('ignores answers for a candidate that is no longer current', () => {
    let state = handleCheckReducer(initialHandleCheck('maya'), {
      type: 'input',
      value: 'maya2',
      current: 'maya',
    })
    state = handleCheckReducer(state, { type: 'checking', handle: 'maya2' })
    expect(state.status).toBe('checking')
    state = handleCheckReducer(state, { type: 'input', value: 'maya3', current: 'maya' })
    state = handleCheckReducer(state, { type: 'result', handle: 'maya2', available: true })
    expect(state).toMatchObject({ handle: 'maya3', status: 'idle' })
    state = handleCheckReducer(state, { type: 'result', handle: 'maya3', available: false })
    expect(state.status).toBe('taken')
    state = handleCheckReducer(state, { type: 'error', handle: 'maya3' })
    expect(state.status).toBe('error')
  })
})

describe('credentials', () => {
  it('reads email and phone off the session', () => {
    expect(credentialsFrom(null)).toEqual({ email: null, phone: null })
    expect(
      credentialsFrom({ access_token: 't', user: { id: 'u', email: 'a@b.co', phone: '' } }),
    ).toEqual({
      email: 'a@b.co',
      phone: null,
    })
  })

  it('walks enter → code → done and restarts cleanly', () => {
    let flow = initialCredentialFlow('phone')
    flow = credentialFlowReducer(flow, { type: 'destination', value: '+14155550100' })
    flow = credentialFlowReducer(flow, { type: 'busy' })
    expect(flow.busy).toBe(true)
    flow = credentialFlowReducer(flow, { type: 'sent' })
    expect(flow).toMatchObject({ step: 'code', busy: false })
    flow = credentialFlowReducer(flow, { type: 'code', value: '123456' })
    flow = credentialFlowReducer(flow, { type: 'failed', error: 'bad' })
    expect(flow).toMatchObject({ step: 'code', error: 'bad', busy: false })
    flow = credentialFlowReducer(flow, { type: 'verified' })
    expect(flow.step).toBe('done')
    flow = credentialFlowReducer(flow, { type: 'restart' })
    expect(flow).toMatchObject({ step: 'enter', destination: '+14155550100', method: 'phone' })
  })

  it('carries the delete request as a help review', () => {
    expect(DELETE_ACCOUNT_REVIEW).toEqual({ kind: 'help', details: { action: 'delete' } })
  })
})
