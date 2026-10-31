import type { TurnBoundaryProjection } from './types.ts'
import type {} from '@moonya/harness-session-projection'

declare module '@moonya/harness-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The agent session's open/last turn and step boundary facts (whole value). */
    turnBoundary: TurnBoundaryProjection
  }
}

export {}
