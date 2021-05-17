import { Config, resolve, ResolvedConfig } from './config'
import { PromiseSettledCoordinator } from './promises'
import { RequestTracer, Span } from './logging'

type WorkerEvent = FetchEvent

type OrPromise<T> = T | PromiseLike<T>
type PromiseResolve<T> = (value: OrPromise<T>) => void

class LogWrapper {
  protected waitUntilResolve?: PromiseResolve<void>
  protected readonly tracer: RequestTracer
  protected waitUntilSpan: Span
  protected waitUntilUsed: boolean = false
  protected readonly config: ResolvedConfig
  protected readonly settler: PromiseSettledCoordinator
  constructor(public readonly event: WorkerEvent, protected listener: EventListener, config: ResolvedConfig) {
    this.config = config
    this.tracer = new RequestTracer(event.request, this.config)
    this.waitUntilSpan = this.tracer.startChildSpan('waitUntil', 'worker')
    this.settler = new PromiseSettledCoordinator(() => {
      this.waitUntilSpan.finish()
      this.sendEvents()
    })
    this.setupWaitUntil()
    this.setUpRespondWith()
  }

  protected async sendEvents(): Promise<void> {
    const excludes = this.waitUntilUsed ? [] : ['waitUntil']
    await this.tracer.sendEvents(excludes)
    this.waitUntilResolve!()
  }

  protected finishResponse(response?: Response, error?: Error) {
    if (response) {
      this.tracer.addResponse(response)
    } else if (error) {
      this.tracer.addData({ exception: true, responseException: error.toString() })
      if (error.stack) this.tracer.addData({ stacktrace: error.stack })
    }
    this.tracer.finish()
  }

  protected startWaitUntil() {
    this.waitUntilUsed = true
    this.waitUntilSpan.start()
  }

  protected finishWaitUntil(error?: Error) {
    if (error) {
      this.tracer.addData({ exception: true, waitUtilException: error.toString() })
      this.waitUntilSpan.addData({ exception: error })
      if (error.stack) this.waitUntilSpan!.addData({ stacktrace: error.stack })
    }
  }

  private setupWaitUntil(): void {
    const waitUntilPromise = new Promise<void>((resolve) => {
      this.waitUntilResolve = resolve
    })
    this.event.waitUntil(waitUntilPromise)
    this.proxyWaitUntil()
  }

  private proxyWaitUntil() {
    const logger = this
    this.event.waitUntil = new Proxy(this.event.waitUntil, {
      apply: function (_target, _thisArg, argArray) {
        logger.startWaitUntil()
        const promise: Promise<any> = Promise.resolve(argArray[0])
        logger.settler.addPromise(promise)
        promise
          .then(() => {
            logger.finishWaitUntil()
          })
          .catch((reason?) => {
            logger.finishWaitUntil(reason)
          })
      },
    })
  }

  private setUpRespondWith() {
    this.proxyRespondWith()
    try {
      this.event.request.tracer = this.tracer
      this.event.waitUntilTracer = this.waitUntilSpan
      this.listener(this.event)
    } catch (err) {
      this.finishResponse(undefined, err)
    }
  }

  private proxyRespondWith() {
    const logger = this
    this.event.respondWith = new Proxy(this.event.respondWith, {
      apply: function (target, thisArg, argArray) {
        const responsePromise: Promise<Response> = Promise.resolve(argArray[0])
        Reflect.apply(target, thisArg, argArray) //call event.respondWith with the wrapped promise
        const promise = new Promise<Response>((resolve, reject) => {
          responsePromise
            .then((response) => {
              setTimeout(() => {
                logger.finishResponse(response)
                resolve(response)
              }, 1)
            })
            .catch((reason) => {
              setTimeout(() => {
                logger.finishResponse(undefined, reason)
                reject(reason)
              }, 1)
            })
        })
        logger.settler.addPromise(promise)
      },
    })
  }
}

export function wrapEventListener(cfg: Config, listener: EventListener): EventListener {
  const config = resolve(cfg)
  return new Proxy(listener, {
    apply: function (_target, _thisArg, argArray) {
      const event = argArray[0] as WorkerEvent
      new LogWrapper(event, listener, config)
    },
  })
}

const hc = wrapEventListener
export { hc }
