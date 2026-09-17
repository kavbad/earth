/** Spec §45 step 2: "Optional: Give this group a name" — Skip allowed. */
import { ClaimSteps } from '@earth/auth'
import { GROUP_NAME_MAX } from '@earth/domain'
import { copy, space } from '@earth/ui'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { useClaimFlow } from '@/components/claim/ClaimFlowProvider'
import { ClaimFrame, ClaimTitle } from '@/components/claim/ClaimFrame'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/TextField'
import { stateFromPending } from '@/lib/claim/flow'
import { shellCopy } from '@/lib/copy'

export default function ClaimStartGroupScreen() {
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

  return (
    <ClaimFrame>
      <ClaimTitle>{copy.optionalGroupName}</ClaimTitle>
      <View style={styles.form}>
        <TextField
          label={shellCopy.groupNameLabel}
          value={label}
          onChangeText={setLabel}
          maxLength={GROUP_NAME_MAX}
          autoFocus
          returnKeyType="next"
          onSubmitEditing={() => submit(label)}
        />
        <Button
          variant="primary"
          fullWidth
          label={shellCopy.continue}
          onPress={() => submit(label)}
        />
        <Button variant="quiet" fullWidth label={copy.skip} onPress={() => submit(null)} />
      </View>
    </ClaimFrame>
  )
}

const styles = StyleSheet.create({
  form: { gap: space[3] },
})
