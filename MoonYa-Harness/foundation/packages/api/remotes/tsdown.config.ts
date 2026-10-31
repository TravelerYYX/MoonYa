import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@moonya/harness-api-remotes',
  ['lib/types/index.js'],
  { hostPhase: true },
)
