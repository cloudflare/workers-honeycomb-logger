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

}

function proxyFetch(do_name: string, tracer: RequestTracer, obj: DurableObject): DurableObject['fetch'] {
  return new Proxy(obj.fetch, {
    apply: (target, thisArg, argArray) => {
      const info = argArray[0] as Request
      const input = argArray[1] as RequestInit
      const request = new Request(info, input)
      const childSpan = tracer.startChildSpan(request.url, do_name)

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
}

function proxyGet(fn: Function, tracer: RequestTracer, do_name: string) {
  return new Proxy(fn, {
    apply: (target, thisArg, argArray) => {
      const obj = Reflect.apply(target, thisArg, argArray)
      obj.fetch = proxyFetch(do_name, tracer, obj)
      return obj
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

        const tracer = new RequestTracer(request, config)
        request.tracer = tracer

        const env = argArray[1] as HoneycombEnv
        argArray[1] = proxyEnv(env, tracer)
        config.apiKey = env.HONEYCOMB_API_KEY || config.apiKey
        config.dataset = env.HONEYCOMB_DATASET || config.dataset

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

type ObjFetch = DurableObject['fetch']

function proxyObjFetch(config: ResolvedConfig, orig_fetch: ObjFetch, do_name: string): ObjFetch {
  return new Proxy(orig_fetch, {
    apply: (target, thisArg, argArray): Promise<Response> => {
      const request = argArray[0] as Request

      const tracer = new RequestTracer(request, config)
      tracer.eventMeta.service_name = do_name
      tracer.eventMeta.name = new URL(request.url).pathname
      request.tracer = tracer
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

type DOClass = { new (...args: any[]): DurableObject }

export function wrapDurableObject(cfg: Config, do_class: DOClass): DOClass {
  const config = resolve(cfg)
  config.acceptTraceContext = true
  return new Proxy(do_class, {
    construct: (target, argArray) => {
      const obj = new target(...argArray)
      obj.fetch = proxyObjFetch(config, obj.fetch, do_class.name)
      return obj
    },
  })
}
