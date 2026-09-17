'use client'

/** Spec §45 step 2: "Optional: Give this group a name" — Skip allowed. */
import { ClaimSteps } from '@earth/auth'
import { GROUP_NAME_MAX } from '@earth/domain'
import { copy } from '@earth/ui'
import { type FormEvent, useState } from 'react'

import { Button } from '../../../components/ui/Button'
import { TextField } from '../../../components/ui/TextField'
import { stateFromPending } from '../../../lib/claim/flow'
import { webCopy } from '../../../lib/copy'
import { useClaimFlow } from '../_components/ClaimFlowProvider'
import { ClaimTitle } from '../_components/ClaimFrame'

export default function ClaimStartGroupPage() {
  const { state, dispatch, flags } = useClaimFlow()
  const [label, setLabel] = useState(state.groupLabel ?? '')

  const submit = (value: string | null) => {
    if (state.step !== ClaimSteps.group_label) {
      // Back here from the credential step: restart the start-group branch with the new label.
      dispatch({ type: 'reset', state: stateFromPending(null, flags) })
      dispatch({ type: 'chooseStart' })
    }
    dispatch({ type: 'labelSet', label: value })
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    submit(label)
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <ClaimTitle>{copy.optionalGroupName}</ClaimTitle>
      <TextField
        label={webCopy.groupNameLabel}
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        maxLength={GROUP_NAME_MAX}
        autoFocus
        autoComplete="off"
      />
      <Button type="submit" variant="primary" fullWidth>
        {webCopy.continue}
      </Button>
      <Button variant="quiet" fullWidth onClick={() => submit(null)}>
        {copy.skip}
      </Button>
    </form>
  )
}
