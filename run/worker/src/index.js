import { hc } from '../../../dist/index'

const config = {
  dataset: 'my-first-dataset',
  apiKey: '7637a2074573880feb71ffb39e94b75d',
  data: {
    git: {
      version: process.env.GIT_VERSION,
      author_date: process.env.GIT_AUTHOR_DATE,
    },
  },
  parse: request => {
    return { myowntopurl: request.url }
  },
  parseSubrequest: request => {
    return { myownsuburl: request.url }
  },
}

async function handleRequest(request) {
  await request.tracer.fetch('https://docs.honeycomb.io')
  return request.tracer.fetch('https://docs.honeycomb.io/api/events/')
}

async function handleWaitUntil(event, response) {
  await event.waitUntilTracer.fetch('https://cloudflare.com')
}

async function handleEvent(event) {
  const response = await handleRequest(event.request)
  event.waitUntil(handleWaitUntil(event, response))
  return response
}

const listener = hc(config, event => {
  event.respondWith(handleEvent(event))
})

addEventListener('fetch', listener)
