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

export type SampleRateFn = (data: any) => number

export type HttpStatusBuckets = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'exception'

export type SampleRates = Record<HttpStatusBuckets, number>

export type ResolvedConfig = {
  acceptTraceContext: boolean
  apiKey: string
  data: object
  dataset: string
  redactRequestHeaders: string[]
  redactResponseHeaders: string[]
  sampleRates: SampleRates | SampleRateFn
  serviceName: string
  sendTraceContext: boolean | RegExp
  debugLog: boolean
}

export type Config = Partial<ResolvedConfig>

const configDefaults: ResolvedConfig = {
  acceptTraceContext: false,
  apiKey: '',
  dataset: '',
  data: {},
  redactRequestHeaders: ['authorization', 'cookie', 'referer'],
  redactResponseHeaders: ['set-cookie'],
  sampleRates: () => 1,
  sendTraceContext: false,
  serviceName: 'worker',
  debugLog: true,
}

function resolve(cfg: Config): ResolvedConfig {
  const config = Object.assign({}, configDefaults, cfg)
  config.redactRequestHeaders = config.redactRequestHeaders.map((header) => header.toLowerCase())
  config.redactResponseHeaders = config.redactResponseHeaders.map((header) => header.toLowerCase())
  return config
}

export { resolve }
