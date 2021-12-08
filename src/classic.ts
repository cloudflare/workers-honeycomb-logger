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
      this.tracer.finishResponse(undefined, err as Error)
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
                logger.tracer.finishResponse(response)
                resolve(response)
              }, 1)
            })
            .catch((reason) => {
              setTimeout(() => {
                logger.tracer.finishResponse(undefined, reason)
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
