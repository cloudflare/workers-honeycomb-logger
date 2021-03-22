import { Listener, hc, WorkerEvent } from '../src/index'
//@ts-ignore
import * as fetch from 'node-fetch'

globalThis.fetch = fetch
//@ts-ignore
globalThis.Request = fetch.Request
//@ts-ignore
globalThis.Response = fetch.Response
globalThis.Headers = fetch.Headers

const addEventListener2 = (type: string, listener: Listener) => {
  const event = {
    request: new Request('https://blah.com'),
    respondWith: (response: Response | Promise<Response>) => {
      console.log(`got: ${response}`)
    },
    waitUntil: (promise: Promise<any>) => {
      console.log('added waitUntil!')
    },
  }
  //@ts-ignore
  listener(event)
  console.log('Too late!')
}

const config = {
  dataset: 'my-first-dataset',
  apiKey: '7637a2074573880feb71ffb39e94b75d',
}

const handleEvent = async (event: WorkerEvent) => {
  return new Response('Hello World')
}

const listener = hc(config, (event) => {
  //@ts-ignore
  event.respondWith(handleEvent(event))
})

addEventListener2('fetch', listener)
