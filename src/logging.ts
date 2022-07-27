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

import { HttpStatusBuckets, ResolvedConfig } from './config'
import { TraceContext } from './tracecontext'

declare global {
  interface FetchEvent {
    waitUntilTracer: Span
  }

  interface Request {
    tracer: Span
  }
}

interface HoneycombEvent {
  timestamp: number
  name: string
  trace: TraceContext
  service: {
    name: string
  }
  duration_ms?: number
}

interface SpanInit {
  name: string
  trace_context: TraceContext
  service: {
    name: string
  }
}

const convertHeaders = (from: Headers, redacted: string[]): Record<string, string> => {
  const to: Record<string, string> = {}
  for (let [key, value] of from.entries()) {
    key = key.toLowerCase()
    to[key] = redacted.includes(key) ? 'REDACTED' : value
  }

  return to
}

const shouldSendTraceContext = (sendTraceContext: boolean | RegExp, url: string): boolean => {
  if (sendTraceContext instanceof RegExp) {
    return url.match(sendTraceContext) !== null
  } else {
    return sendTraceContext
  }
}

export class Span {
  public readonly eventMeta: HoneycombEvent
  protected readonly data: any = {}
  protected readonly childSpans: Span[] = []
  protected request?: Request
  protected response?: Response
  protected constructor(init: SpanInit, protected readonly config: ResolvedConfig) {
    this.eventMeta = {
      timestamp: Date.now(),
      name: init.name,
      trace: init.trace_context,
      service: init.service,
    }
  }

  public toHoneycombEvents(): HoneycombEvent[] {
    const event: HoneycombEvent = Object.assign({}, this.data, this.eventMeta)
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
      referrer: request.headers.get('referer'),
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

  public fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init)
    const childSpan = this.startChildSpan(request.url, 'fetch')

    if (shouldSendTraceContext(this.config.sendTraceContext, request.url)) {
      const traceHeaders = childSpan.eventMeta.trace.getHeaders()
      request.headers.set('traceparent', traceHeaders.traceparent)
      if (traceHeaders.tracestate) request.headers.set('tracestate', traceHeaders.tracestate)
    }

    childSpan.addRequest(request)
    const promise = fetch(request)
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

  public startChildSpan(name: string, serviceName?: string): Span {
    const trace = this.eventMeta.trace
    const service = serviceName ? { name: serviceName } : this.eventMeta.service
    const span = new Span({ name, trace_context: trace.getChildContext(), service }, this.config)
    this.childSpans.push(span)
    return span
  }
}

export class RequestTracer extends Span {
  public sampleRate?: number
  constructor(protected readonly request: Request, config: ResolvedConfig) {
    super(
      {
        name: 'request',
        trace_context: TraceContext.newTraceContext(config.acceptTraceContext ? request : undefined),
        service: {
          name: config.serviceName,
        },
      },
      config,
    )
    this.addRequest(request)
    this.addData(config.data)
  }

  public async sendEvents(excludeSpans?: string[]) {
    const sampleRate = this.getSampleRate(this.data)
    if (sampleRate >= 1 && Math.random() < 1 / sampleRate) {
      const events = this.toHoneycombEvents().filter((event) =>
        excludeSpans ? !excludeSpans.includes(event.name) : true,
      )
      await this.sendBatch(events, sampleRate)
    }
  }

  public finishResponse(response?: Response, error?: Error) {
    if (response) {
      this.addResponse(response)
    } else if (error) {
      this.addData({ exception: true, responseException: error.toString() })
      if (error.stack) this.addData({ stacktrace: error.stack })
    }
    this.finish()
  }

  public setSampleRate(sampleRate: number) {
    this.sampleRate = sampleRate
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
    const response = await fetch(request)
    this.debugLog('Honeycomb Response Status: ' + response.status)
    const text = await response.text()
    this.debugLog('Response: ' + text)
  }

  private debugLog(msg: string) {
    if (this.config.debugLog) {
      console.log(msg)
    }
  }

  private getSampleRate(data: any): number {
    if (this.sampleRate !== undefined) {
      return this.sampleRate
    }
    const sampleRates = this.config.sampleRates
    if (typeof sampleRates === 'function') {
      return sampleRates(data)
    } else if (typeof data.response === 'object' && typeof data.response.status === 'number') {
      const key = `${data.response.status.toString()[0]}xx` as HttpStatusBuckets
      return sampleRates[key] || 1
    } else {
      return sampleRates.exception
    }
  }
}
