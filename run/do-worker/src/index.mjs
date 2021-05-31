import isOdd from 'is-odd'
import { wrapModule } from '../../../dist/modules'

// In order for the workers runtime to find the class that implements
// our Durable Object namespace, we must export it from the root module.
export { Counter } from './counter.mjs'

const worker = {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env)
    } catch (e) {
      return new Response(e.message)
    }
  },
}

async function handleRequest(request, env) {
  let id = env.COUNTER.idFromName('A')
  let obj = env.COUNTER.get(id)
  let resp = await obj.fetch(request.url)
  let count = parseInt(await resp.text())
  let wasOdd = isOdd(count) ? 'is odd' : 'is even'

  return new Response(`${count} ${wasOdd}`)
}

const config = {
  apiKey: '__HONEYCOMB_API_KEY__',
  dataset: 'my-first-dataset',
}

export default wrapModule(config, worker)
