import { StyleSheet, Text, View } from 'react-native'

import { APP_NAME } from '@earth/ui'

export default function IndexScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.wordmark}>{APP_NAME}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordmark: {
    fontSize: 24,
    fontWeight: '600',
    letterSpacing: -0.5,
    color: '#111111',
  },
})
