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

import { Config, resolve, ResolvedConfig } from './config'
import { RequestTracer } from './logging'

export interface HoneycombEnv {
  HONEYCOMB_API_KEY?: string
  HONEYCOMB_DATASET?: string
}

function cacheTraceId(trace_id: string): void {
  const headers = {
    'cache-control': 'max-age=90',
  }
  caches.default.put(`https://fake-trace-cache.com/${trace_id}`, new Response('Ok', { headers }))
}

async function isRealTraceRequest(trace_id: string): Promise<boolean> {
  const url = `https://fake-trace-cache.com/${trace_id}`
  const response = await caches.default.match(url)
  const found = !!response
  if (found) {
    caches.default.delete(url)
  }
  return found
}

async function sendEventToHoneycomb(request: Request, config: ResolvedConfig): Promise<Response> {
  const event: any = await request.json()
  if (await isRealTraceRequest(event.trace.trace_id)) {
    const url = `https://api.honeycomb.io/1/events/${encodeURIComponent(config.dataset)}`
    const params = {
      method: 'POST',
      body: JSON.stringify(event),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Honeycomb-Team': config.apiKey,
        'X-Honeycomb-Event-Time': event.timestamp || event.Timestamp,
      },
    }
    return fetch(url, params)
  } else {
    return new Response(`No trace found with ID: ${event.trace.trace_id}`)
  }
}

type OutgoingFetcher = { fetch: typeof fetch }

function proxyFetch(obj: OutgoingFetcher, tracer: RequestTracer, name: string): OutgoingFetcher {
  obj.fetch = new Proxy(obj.fetch, {
    apply: (target, thisArg, argArray) => {
      const info = argArray[0] as Request
      const input = argArray[1] as RequestInit
      const request = new Request(info, input)
      const childSpan = tracer.startChildSpan(request.url, name)

      const traceHeaders = childSpan.eventMeta.trace.getHeaders()
      request.headers.set('traceparent', traceHeaders.traceparent)
      if (traceHeaders.tracestate) request.headers.set('tracestate', traceHeaders.tracestate)

      childSpan.addRequest(request)
      const promise = Reflect.apply(target, thisArg, [request]) as Promise<Response>
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
    },
  })
  return obj
}

function proxyGet(fn: Function, tracer: RequestTracer, do_name: string) {
  return new Proxy(fn, {
    apply: (target, thisArg, argArray) => {
      const obj = Reflect.apply(target, thisArg, argArray)
      return proxyFetch(obj, tracer, do_name)
    },
  })
}

function proxyNS(dns: DurableObjectNamespace, tracer: RequestTracer, do_name: string) {
  return new Proxy(dns, {
    get: (target, prop, receiver) => {
      const value = Reflect.get(target, prop, receiver)
      if (prop === 'get') {
        return proxyGet(value, tracer, do_name).bind(dns)
      } else {
        return value ? value.bind(dns) : undefined
      }
    },
  })
}

function proxyEnv(env: any, tracer: RequestTracer): any {
  return new Proxy(env, {
    get: (target, prop, receiver) => {
      const value = Reflect.get(target, prop, receiver)
      if (value && value.idFromName) {
        return proxyNS(value, tracer, prop.toString())
      } else if (value && value.fetch) {
        return proxyFetch(value, tracer, prop.toString())
      } else {
        return value
      }
    },
  })
}

function workerProxy<T>(config: ResolvedConfig, mod: ExportedHandler<T>): ExportedHandler<T> {
  return {
    fetch: new Proxy(mod.fetch!, {
      apply: (target, thisArg, argArray): Promise<Response> => {
        const request = argArray[0] as Request
        if (new URL(request.url).pathname === '/_send_honeycomb_event') {
          return sendEventToHoneycomb(request, config)
        }

        const tracer = new RequestTracer(request, config)
        if (tracer.eventMeta.trace.parent_id) {
          //this is part of a distributed trace
          cacheTraceId(tracer.eventMeta.trace.trace_id)
        }
        request.tracer = tracer

        const env = argArray[1] as HoneycombEnv
        argArray[1] = proxyEnv(env, tracer)
        config.apiKey = env.HONEYCOMB_API_KEY || config.apiKey
        config.dataset = env.HONEYCOMB_DATASET || config.dataset

        if (!config.apiKey || !config.dataset) {
          throw new Error('Need both HONEYCOMB_API_KEY and HONEYCOMB_DATASET to be configured.')
        }

        const ctx = argArray[2] as ExecutionContext

        //TODO: proxy ctx.waitUntil

        try {
          const result: Response | Promise<Response> = Reflect.apply(target, thisArg, argArray)
          if (result instanceof Response) {
            tracer.finishResponse(result)
            ctx.waitUntil(tracer.sendEvents())
            return Promise.resolve(result)
          } else {
            result.then((response) => {
              tracer.finishResponse(response)
              ctx.waitUntil(tracer.sendEvents())
              return response
            })
            result.catch((err) => {
              tracer.finishResponse(undefined, err)
              ctx.waitUntil(tracer.sendEvents())
              throw err
            })
            return result
          }
        } catch (err) {
          tracer.finishResponse(undefined, err as Error)
          ctx.waitUntil(tracer.sendEvents())
          throw err
        }
      },
    }),
  }
}

type DoFetch = DurableObject['fetch']

function proxyObjFetch(config: ResolvedConfig, orig_fetch: DoFetch, do_name: string, env: HoneycombEnv): DoFetch {
  return new Proxy(orig_fetch, {
    apply: (target, thisArg, argArray: Parameters<DurableObject['fetch']>): Promise<Response> => {
      const request = argArray[0] as Request

      const tracer = (request.tracer = new RequestTracer(request, config))

      config.apiKey = env.HONEYCOMB_API_KEY || config.apiKey
      config.dataset = env.HONEYCOMB_DATASET || config.dataset

      if (!config.apiKey || !config.dataset) {
        throw new Error('Need both HONEYCOMB_API_KEY and HONEYCOMB_DATASET to be configured.')
      }

      tracer.eventMeta.service.name = do_name
      tracer.eventMeta.name = new URL(request.url).pathname
      try {
        const result: Response | Promise<Response> = Reflect.apply(target, thisArg, argArray)
        if (result instanceof Response) {
          tracer.finishResponse(result)
          tracer.sendEvents()
          return Promise.resolve(result)
        } else {
          result.then((response) => {
            tracer.finishResponse(response)
            tracer.sendEvents()
            return response
          })
          result.catch((err) => {
            tracer.finishResponse(undefined, err)
            tracer.sendEvents()
            throw err
          })
          return result
        }
      } catch (err) {
        tracer.finishResponse(undefined, err as Error)
        tracer.sendEvents()
        throw err
      }
    },
  })
}

export function wrapModule<T>(cfg: Config, mod: ExportedHandler<T>): ExportedHandler<T> {
  const config = resolve(cfg)
  return workerProxy(config, mod)
}

type DOClass = { new (state: DurableObjectState, env: HoneycombEnv): DurableObject }

export function wrapDurableObject(cfg: Config, do_class: DOClass): DOClass {
  const config = resolve(cfg)
  config.acceptTraceContext = true
  return new Proxy(do_class, {
    construct: (target, argArray: ConstructorParameters<DOClass>) => {
      const env = argArray[1]
      const obj = new target(...argArray) as DurableObject
      obj.fetch = proxyObjFetch(config, obj.fetch, do_class.name, env)
      return obj
    },
  })
}
