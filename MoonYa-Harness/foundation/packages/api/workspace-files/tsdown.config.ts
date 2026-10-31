import { clientBundle } from '../../client/tsdown.client.ts'

export default clientBundle(
  '@moonya/harness-api-workspace-files',
  ['lib/types/index.js'],
  { hostPhase: true },
)
