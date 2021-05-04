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

import { TraceContext } from './tracecontext'
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
  apiKey: string
  dataset: string
  data?: any
  redactRequestHeaders?: string[]
  redactResponseHeaders?: string[]
  sampleRates?: SampleRates | SampleRateFn
  serviceName?: string
  reportOverride?: (request: Request, body: object) => OrPromise<void>
}

interface InternalConfig extends Config {
  data: any
  redactRequestHeaders: string[]
  redactResponseHeaders: string[]
  sampleRates: (SampleRates & Record<string, number>) | SampleRateFn
  serviceName: string
}

type OrPromise<T> = T | PromiseLike<T>

type PromiseResolve<T> = (value: OrPromise<T>) => void

interface HoneycombEvent {
  timestamp: number
  name: string
  trace: TraceContext
  service_name: string
  duration_ms?: number
  app?: any
}

interface SpanInit {
  name: string
  trace_context: TraceContext
  service_name: string
}

const convertHeaders = (from: Headers, redacted: string[]): Record<string, string> => {
  const to: Record<string, string> = {}
  for (let [key, value] of from.entries()) {
    key = key.toLowerCase()
    to[key] = redacted.includes(key) ? 'REDACTED' : value
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
      trace: init.trace_context,
      service_name: init.service_name,
    }
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
      headers: request.headers ? convertHeaders(request.headers, this.config.redactRequestHeaders) : undefined,
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
      headers: response.headers ? convertHeaders(response.headers, this.config.redactResponseHeaders) : undefined,
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
  }

  public fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init)
    const childSpan = this.startChildSpan(request.url, 'fetch')
    const traceHeaders = this.eventMeta.trace.getHeaders()
    request.headers.set('traceparent', traceHeaders.traceparent)
    if (traceHeaders.tracestate) request.headers.set('tracestate', traceHeaders.tracestate)
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

  public startChildSpan(name: string, service_name: string): Span {
    const trace = this.eventMeta.trace
    const span = new Span({ name, trace_context: trace.getChildContext(), service_name }, this.config)
    this.childSpans.push(span)
    return span
  }
}

class RequestTracer extends Span {
  constructor(protected readonly request: Request, config: InternalConfig) {
    super(
      {
        name: 'request',
        trace_context: TraceContext.newTraceContext(request),
        service_name: config.serviceName,
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
  data: {},
  redactRequestHeaders: ['authorization', 'cookie', 'referer'],
  redactResponseHeaders: ['set-cookie'],
  sampleRates: {
    '2xx': 1,
    '3xx': 1,
    '4xx': 1,
    '5xx': 1,
    exception: 1,
  },
  serviceName: 'worker',
}

class LogWrapper {
  protected waitUntilResolve?: PromiseResolve<void>
  protected readonly tracer: RequestTracer
  protected waitUntilSpan: Span
  protected waitUntilUsed: boolean = false
  protected readonly config: InternalConfig
  protected readonly settler: PromiseSettledCoordinator
  constructor(public readonly event: WorkerEvent, protected listener: EventListener, config: InternalConfig) {
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

export function hc(cfg: Config, listener: EventListener): EventListener {
  const config = Object.assign({}, configDefaults, cfg)
  config.redactRequestHeaders = config.redactRequestHeaders.map((header) => header.toLowerCase())
  config.redactResponseHeaders = config.redactResponseHeaders.map((header) => header.toLowerCase())
  return new Proxy(listener, {
    apply: function (_target, _thisArg, argArray) {
      const event = argArray[0] as WorkerEvent
      new LogWrapper(event, listener, config)
    },
  })
}
