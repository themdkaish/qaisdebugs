/**
 * The inspector reads the event types straight from the agent's source, so there is exactly one
 * definition. Type-only, so nothing from the agent ends up in the UI bundle.
 */
export type {
  AgentEvent,
  DevtoolsEvent,
  ErrorEvent,
  LogEvent,
  LogLevel,
  RequestEvent,
  RequestOrigin,
  StackFrame,
} from '../../agent/shared/events';
