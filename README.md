`workers-honeycomb-logger` is a simple library that lets you wrap your Worker listener, configure with an Honeycomb API key and dataset, and it will automatically send every request to be logged in Honeycomb, where you can easily query, graph and monitor your workers from there.


### Introduction

⚠️`workers-honeycomb-logger` **is currently in beta. We do not recommend using it for production workloads just yet.** ⚠️

It currently only supports workers that have exactly one `EventListener` that always returns a `Response`. And we currently also support at most one `waitUntill` call. If your worker does not return a Response (to have an origin handle the request for example) or you use multiple `waitUntill()` calls, installing this will change the behaviour of your worker. (And probably for the worse). These are known issue that we will fix before doing a non-beta release.

### Getting started

Installation is done via the usual `npm install @cloudflare/workers-honeycomb-logger` or `yarn add @cloudflare/workers-honeycomb-logger`.

The next two things you need are a Honeycomb API key and a dataset name. You can pick any dataset name you like, Honeycomb will automatically create a new dataset if it sees a new name.

Next you need to wrap your listener with the honeycomb logger. So if your current code looks something like this:

``` javascript
addEventListener('fetch', (event) => {
  event.respondWith(handleRequest(event.request))
})

function handleRequest(request) {
  //your worker code.
}
```

You can change that to:

``` javascript
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


