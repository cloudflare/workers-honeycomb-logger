Honeycomb logger is a simple library that lets you extremely easy export runtime information from your Cloudflare Workers into [Honeycomb](https://honeycomb.io).
Honeycomb is an observability platform which allows you to query and graph across any (number of) dimension(s) you have in your data. So you can for example graph request duration for 200 response codes, for GET requests, to a particular URL, for a particular customer.

Or you can drill into all an entire trace of a request that errored out, including all subrequests.

Table of Contents

- [Beta Warning](#beta-warning)
- [Getting Started](#getting-started)
- [Config](#config)
- [Adding logs and other data](#adding-logs-and-other-data)
- [Traces](#traces)
- [Dynamic Sampling](#dynamic-sampling)

### Beta Warning!

⚠️`workers-honeycomb-logger` **is currently in beta. We do not recommend using it for production workloads just yet.** ⚠️

It currently only supports workers that have exactly one `EventListener` that always returns a `Response`. And we currently also support at most one `waitUntill` call. If your worker does not return a Response (to have an origin handle the request for example) or you use multiple `waitUntill()` calls, installing this will change the behaviour of your worker. (And probably for the worse). These are known issue that we will fix before doing a non-beta release.

### Getting started

Installation is done via the usual `npm install @cloudflare/workers-honeycomb-logger` or `yarn add @cloudflare/workers-honeycomb-logger`.

The next two things you need are a Honeycomb API key and a dataset name. You can pick any dataset name you like, Honeycomb will automatically create a new dataset if it sees a new name.

Next you need to wrap your listener with the honeycomb logger. So if your current code looks something like this:

```javascript
addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request))
})

function handleRequest(request) {
  //your worker code.
}
```

You can change that to:

```javascript
import { hc } from '@cloudflare/workers-honeycomb-logger'

const hc_config = {
  apiKey: '<api_key>',
  dataset: 'my-first-dataset',
}
const listener = hc(hc_config, (event) => {
  event.respondWith(handleRequest(event.request))
})

addEventListener('fetch', listener)

function handleRequest(request) {
  //your worker code.
}
```

### Config

The config object can take a few extra parameters to add more detail to the events that are sent to Honeycomb or configure other aspects.

```typescript
interface Config {
  apiKey: string //The honeycomb API Key
  datase: string //The name of the dataset
  data?: any //Any data you want to add to every request. Things like service name, version info etc.
  redactRequestHeaders?: string[] //Array of headers to redact. Will replace value with `REDACTED`. default is ['authorization', 'cookie', 'referer'].
  redactResponseHeaders?: string[] //Array of headers to redact. Will replace value with `REDACTED`. default is ['set-cookie'].
  sampleRates?: SampleRates | SampleRateFn //Either an object or function that configured sampling (See below)
  data?: any //Any static data that you want to add to every request. This could be a service or the version for example.
}
```

NOTE: In previous versions there were methods for parsing request and responses, but this becomes an issue when reading the body of the request or the response, so it has been removed. If you want add any information you can do so with the `tracer.addData` method described below.

### Adding logs and other data

If you want to add any other data or logs to the current request, you can use the `tracer.addData(data: object)` and `tracer.log(message: string)` methods.
You can get a reference to the tracer either on the request object, or the second argument in the listener.

```typescript
async function handleRequest(request: TracerRequest) {
  request.tracer.log('handling request')
  const customer = parseCustomer(request)
  request.tracer.addData({customer: customer.name})
  return ...
}
```

### Traces

Honeycomb has a concept of a trace, which is a hierarchial representatation of an event. The Cloudflare Worker Honeycomb logger supports trace events for subrequests (outgoing HTTP fetch requests in your worker) like this:

<img width="1089" alt="Screenshot 2021-03-18 at 10 53 06 AM" src="https://user-images.githubusercontent.com/890386/111732941-ca13d200-88ca-11eb-94cb-a4f30a462788.png">

To be able to associate the a subrequest with the correct incoming request, you will have to use the fetch defined on the tracer described above. The method on the tracer delegates all arguments to the regular fetch method, so the `tracer.fetch` function is a drop-in replacement for all `fetch` function calls.

Example:

```typescript
async function handleRequest(request: TracerRequest) {
  return request.tracer.fetch('https://docs.honeycomb.io/api/events/')
}
```

### Dynamic Sampling

One of the challenges with storing all this information per request is that when you scale that up to past tens of millions of requests as month, it becomes more and more expensive. But at the same time you are almost certainly not very interested in the vast majority of the events. Which is why Honeycomb supports sampling. Sending only a portion of the events there. The problem with doing simple sampling (like sending only 1 in 10 requests for example), is that you lose a lot of events that happen rarely. So Honeycomb and this library support dynamic sampling.
The easiest sampling that you can configure is by response code. So you can configure to keep only 1 in 10 responses code 200s, and keep all 5xx.

```typescript
export interface SampleRates {
  '2xx': number
  '3xx': number
  '4xx': number
  '5xx': number
  exception: number
}
```

In an example:

```typescript
const hc_config = {
  api_key: 'abcd',
  dataset: 'my-first-dataset',
  sampleRates: {
    '2xx': 10,
    '3xx': 5,
    '4xx': 2,
    '5xx': 1,
    exception: 1,
  },
}
```

This configures the library to only send 1 in 10 requests with a response code in the 200s, but keep all errors; both 500s and exceptions.

If you want more fine-grained control over your sampling, you are supply a function that takes both a `Request` and optionally a `Response` and you can return a number, which is the amount of events this request should represent.
