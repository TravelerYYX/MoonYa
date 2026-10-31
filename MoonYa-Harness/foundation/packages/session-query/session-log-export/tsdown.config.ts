import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@moonya/harness-session-log-export',
  ['lib/types/index.js'],
  { hostPhase: true },
)
