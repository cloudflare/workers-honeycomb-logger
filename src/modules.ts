import { Config, resolve } from './config'
import { RequestTracer } from './logging'

export interface WorkerContext {
  waitUntil: (promise: Promise<any>) => void
}

export interface HoneycombEnv {
  HONEYCOMB_API_KEY?: string
  HONEYCOMB_DATASET?: string
}

export interface WorkerModule {
  fetch: (request: Request, env: any, ctx: WorkerContext) => Response | Promise<Response>
}

export function wrapModule(cfg: Config, mod: WorkerModule): WorkerModule {
  const config = resolve(cfg)
  return {
    fetch: new Proxy(mod.fetch, {
      apply: (target, thisArg, argArray): Promise<Response> => {
        const request = argArray[0] as Request
        const env = argArray[1] as HoneycombEnv
        config.apiKey = env.HONEYCOMB_API_KEY || config.apiKey
        config.dataset = env.HONEYCOMB_DATASET || config.dataset

        const ctx = argArray[2] as WorkerContext
        const tracer = new RequestTracer(request, config)
        request.tracer = tracer
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
          tracer.finishResponse(undefined, err)
          ctx.waitUntil(tracer.sendEvents())
          throw err
        }
      },
    }),
  }
}
