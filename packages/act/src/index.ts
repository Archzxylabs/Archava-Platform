import type {
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
} from '@archava/assistant'
import type { BookingActionExecutor } from '@archava/act-booking'
import type { EmailActionExecutor } from '@archava/act-email'

/**
 * Server-side dispatch only. The assistant turn pipeline owns capability,
 * role, user confirmation, entity resolution and input validation. A direct
 * call to this port is not an authorization decision.
 */
export class ActActionExecutor implements ActionExecutor {
  readonly executorId = 'act-dispatch@1'

  constructor(
    private readonly booking: BookingActionExecutor,
    private readonly email: EmailActionExecutor,
  ) {}

  execute(request: ActionExecutionRequest): Promise<ActionExecutionResult> {
    if (request.action === 'booking.create') return this.booking.execute(request)
    if (request.action === 'email.send') return this.email.execute(request)
    return Promise.resolve({
      status: 'failed',
      errorCode: 'act_action_not_dispatched',
      retryable: false,
      message: 'This Act executor cannot run the requested action.',
    })
  }
}
