/** BSD 3-Clause License

Copyright (c) 2021, Cloudflare Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import { v4 as uuidv4 } from 'uuid'
import { PromiseSettledCoordinator } from './promises'

declare global {
  interface FetchEvent {
    waitUntilTracer: Span
  }

  interface Request {
    tracer: Span
  }
}

export type WorkerEvent = FetchEvent

export type SampleRateFn = (request: Request, response?: Response) => number
export interface SampleRates {
  '2xx': number
  '3xx': number
  '4xx': number
  '5xx': number
  exception: number
}
export interface Config {
  dataset: string
  apiKey: string
  sampleRates?: SampleRates | SampleRateFn
  data?: any
  parse?: (request: Request, response?: Response) => any
  parseSubrequest?: (request: Request, response?: Response) => any
  reportOverride?: (request: Request, body: object) => OrPromise<void>
}

interface InternalConfig extends Config {
  sampleRates: (SampleRates & Record<string, number>) | SampleRateFn
  data: any
}

type OrPromise<T> = T | PromiseLike<T>

type PromiseResolve<T> = (value: OrPromise<T>) => void

interface TraceInfo {
  span_id: string
  trace_id: string
  parent_id?: string
}
interface HoneycombEvent {
  timestamp: number
  name: string
  trace: TraceInfo
  service_name: string
  duration_ms?: number
  app?: any
}

interface SpanInit {
  name: string
  traceId: string
  serviceName: string
  parentSpanId?: string
}

const convertHeaders = (from: Headers): Record<string, string> => {
  const to = {}
  //@ts-ignore
  for (const [key, value] of from.entries()) {
    //@ts-ignore
    to[key.toLowerCase()] = value
  }
  return to
}

class Span {
  protected readonly eventMeta: HoneycombEvent
  protected readonly data: any = {}
  protected readonly childSpans: Span[] = []
  protected request?: Request
  protected response?: Response
  protected constructor(init: SpanInit, protected readonly config: InternalConfig) {
    this.eventMeta = {
      timestamp: Date.now(),
      name: init.name,
      trace: {
        trace_id: init.traceId,
        span_id: uuidv4(),
      },
      service_name: init.serviceName,
    }
    if (init.parentSpanId) {
      this.eventMeta.trace.parent_id = init.parentSpanId
    }
  }

  public isRootSpan() {
    return !this.eventMeta.trace.parent_id
  }

  public toHoneycombEvents(): HoneycombEvent[] {
    const event: HoneycombEvent = Object.assign({}, this.eventMeta, { app: this.data })
    const childEvents = this.childSpans.map((span) => span.toHoneycombEvents()).flat(1)
    return [event, ...childEvents]
  }

  public addData(data: object) {
    Object.assign(this.data, data)
  }

  public addRequest(request: Request) {
    this.request = request
    if (!request) return
    const json = {
      headers: request.headers ? convertHeaders(request.headers) : undefined,
      method: request.method,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      url: request.url,
    }
    this.addData({ request: json })
  }

  public addResponse(response: Response) {
    this.response = response
    if (!response) return
    const json = {
      headers: response.headers ? convertHeaders(response.headers) : undefined,
      ok: response.ok,
      redirected: response.redirected,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
    }
    this.addData({ response: json })
  }

  public log(message: string) {
    this.data.logs = this.data.logs || []
    this.data.logs.push(message)
  }

  public start() {
    this.eventMeta.timestamp = Date.now()
  }

  public finish() {
    this.eventMeta.duration_ms = Date.now() - this.eventMeta.timestamp
    if (this.isRootSpan() && this.config.parse && this.request) {
      this.addData(this.config.parse(this.request, this.response))
    } else if (this.request && this.config.parseSubrequest) {
      this.addData(this.config.parseSubrequest(this.request, this.response))
    }
  }

  public fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init)
    const childSpan = this.startChildSpan(request.url, 'fetch')
    childSpan.addRequest(request)
    const promise = fetch(input, init)
    promise
      .then((response) => {
        childSpan.addResponse(response)
        childSpan.finish()
      })
      .catch((reason) => {
        childSpan.addData({ exception: reason })
        childSpan.finish()
      })
    return promise
  }

  public startChildSpan(name: string, serviceName: string): Span {
    const trace = this.eventMeta.trace
    const span = new Span({ name, traceId: trace.trace_id, parentSpanId: trace.span_id, serviceName }, this.config)
    this.childSpans.push(span)
    return span
  }
}

class RequestTracer extends Span {
  constructor(protected readonly request: Request, config: InternalConfig) {
    super(
      {
        name: 'request',
        traceId: uuidv4(),
        serviceName: 'worker',
      },
      config,
    )
    this.addRequest(request)
    this.addData(config.data)
  }

  public async sendEvents(excludeSpans?: string[]) {
    const sampleRate = this.getSampleRate(this.request, this.response)
    if (Math.random() < 1 / sampleRate) {
      const events = this.toHoneycombEvents().filter((event) =>
        excludeSpans ? !excludeSpans.includes(event.name) : true,
      )
      await this.sendBatch(events, sampleRate)
    }
  }

  private async sendBatch(events: HoneycombEvent[], sampleRate: number) {
    const url = `https://api.honeycomb.io/1/batch/${encodeURIComponent(this.config.dataset)}`
    const body = events.map((event) => {
      return {
        sampleRate,
        time: new Date(event.timestamp).toISOString(),
        data: event,
      }
    })
    const params = {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Honeycomb-Team': this.config.apiKey,
      },
    }
    const request = new Request(url, params)
    if (this.config.reportOverride) {
      await this.config.reportOverride(request, body)
    } else {
      const response = await fetch(request)
      console.log('Honeycomb Response Status: ' + response.status)
      const text = await response.text()
      console.log('Response: ' + text)
    }
  }

  private getSampleRate(request: Request, response?: Response): number {
    const sampleRates = this.config.sampleRates
    if (typeof sampleRates === 'function') {
      return sampleRates(request, response)
    } else if (!response) {
      return sampleRates.exception
    } else {
      const key = `${response.status.toString()[0]}xx`
      return sampleRates[key]
    }
  }
}

const configDefaults: InternalConfig = {
  apiKey: '',
  dataset: '',
  sampleRates: {
    '2xx': 1,
    '3xx': 1,
    '4xx': 1,
    '5xx': 1,
    exception: 1,
  },
  data: {},
}

class LogWrapper {
  protected waitUntilResolve?: PromiseResolve<void>
  protected readonly tracer: RequestTracer
  protected waitUntilSpan: Span
  protected waitUntilUsed: boolean = false
  protected readonly config: InternalConfig
  protected readonly settler: PromiseSettledCoordinator
  constructor(public readonly event: WorkerEvent, protected listener: EventListener, config: Config) {
    this.config = Object.assign({}, configDefaults, config)
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

  protected finishResponse(response?: Response, error?: any) {
    if (response) {
      this.tracer.addResponse(response)
    } else {
      this.tracer.addData({ exception: true, responseException: error.toString() })
      if (error.stack) this.tracer.addData({ stacktrace: error.stack })
    }
    this.tracer.finish()
  }

  protected startWaitUntil() {
    this.waitUntilUsed = true
    this.waitUntilSpan.start()
  }

  protected finishWaitUntil(error?: any) {
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

export function hc(config: Config, listener: EventListener): EventListener {
  return new Proxy(listener, {
    apply: function (_target, _thisArg, argArray) {
      const event = argArray[0] as WorkerEvent
      new LogWrapper(event, listener, config)
    },
  })
}
