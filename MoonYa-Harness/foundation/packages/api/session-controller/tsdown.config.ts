import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@moonya/harness-api-session-controller',
  ['lib/types/index.js'],
  { hostPhase: true },
)
