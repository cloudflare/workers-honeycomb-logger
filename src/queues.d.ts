// -------- QUEUES INTERFACES --------

// This interfaces are referenced from
// https://developers.cloudflare.com/queues/platform/javascript-apis/

interface MessageBatch<Body = any> {
  readonly queue: string
  readonly messages: Message<Body>[]
  ackAll(): void
  retryAll(): void
}

interface Queue<Body = any> {
  send(body: Body): Promise<void>
  sendBatch(messages: Iterable<MessageSendRequest<Body>>): Promise<void>
}

interface Message<Body = any> {
  readonly id: string
  readonly timestamp: Date
  readonly body: Body
  ack(): void
  retry(): void
}

type MessageSendRequest<Body = any> = {
  body: Body
}

// -------- QUEUES INTERFACES --------

interface QueueHanderResult {
  success: boolean
  data: any
}

declare type ExportedHandlerQueueHandler<Env = unknown> = (
  request: MessageBatch,
  env: Env,
  ctx: ExecutionContext,
  span: any,
) => QueueHanderResult

interface ExportedHandler<Env = unknown> {
  fetch?: ExportedHandlerFetchHandler<Env>
  scheduled?: ExportedHandlerScheduledHandler<Env>
  queue?: ExportedHandlerQueueHandler<Env>
}
