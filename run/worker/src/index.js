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
  request.tracer.addData({ blah: true })
  request.tracer.log('Hello World!')
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
