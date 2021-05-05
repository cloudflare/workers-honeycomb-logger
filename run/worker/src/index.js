import { hc } from '../../../dist/index'

const config = {
  dataset: 'my-first-dataset',
  apiKey: process.env.HONEYCOMB_API_KEY,
  acceptTraceContext: true,
  data: {
    git: {
      version: process.env.GIT_VERSION,
      author_date: process.env.GIT_AUTHOR_DATE,
    },
  },
  redactRequestHeaders: ['my-header'],
  sendTraceContext: true,
}

async function handleRequest(request) {
  await request.tracer.fetch('https://docs.honeycomb.io')
  return request.tracer.fetch('https://docs.honeycomb.io/api/events/')
}

async function handleWaitUntil(event) {
  await event.waitUntilTracer.fetch('https://cloudflare.com')
}

async function handleEvent(event) {
  const response = await handleRequest(event.request)
  event.waitUntil(handleWaitUntil(event))
  return response
}

const listener = hc(config, event => {
  event.respondWith(handleEvent(event))
})

addEventListener('fetch', listener)
