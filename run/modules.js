require('dotenv').config()
const wrapModule = require('../dist/index').wrapModule
const crypto = require('crypto')
const fetch = require('node-fetch')
globalThis.fetch = fetch
globalThis.Request = fetch.Request
globalThis.Response = fetch.Response
globalThis.Headers = fetch.Headers
globalThis.crypto = {
  getRandomValues(buffer) {
    crypto.randomFillSync(buffer)
  },
}

const orig = {
  async fetch(request, env, ctx) {
    request.tracer.log('Hello World!')
    request.tracer.addData({ foo: 'bar' })
    await request.tracer.fetch('https://cloudflare.com')
    request.tracer.log('Done with Cloudlare..')
    return request.tracer.fetch('https://google.com')
  },
}

const config = {
  dataset: 'my-first-dataset',
}

const wrapped = wrapModule(config, orig)

const req = new Request('https://blah.com')
const env = {
  HONEYCOMB_API_KEY: process.env.HONEYCOMB_API_KEY,
}
const ctx = {
  waitUntil(promise) {
    promise.then((result) => {
      console.log('Done!')
    })
  },
}

wrapped.fetch(req, env, ctx)
