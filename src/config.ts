export type SampleRateFn = (data: any) => number

export type HttpStatusBuckets = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'exception'

export type SampleRates = Record<HttpStatusBuckets, number>

export interface Config {
  apiKey: string
  dataset: string
  acceptTraceContext?: boolean
  data?: object
  redactRequestHeaders?: string[]
  redactResponseHeaders?: string[]
  sampleRates?: SampleRates | SampleRateFn
  serviceName?: string
  sendTraceContext?: boolean | RegExp
}

export type ResolvedConfig = Required<Config>

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
}

function resolve(cfg: Config): ResolvedConfig {
  const config = Object.assign({}, configDefaults, cfg)
  config.redactRequestHeaders = config.redactRequestHeaders.map((header) => header.toLowerCase())
  config.redactResponseHeaders = config.redactResponseHeaders.map((header) => header.toLowerCase())
  return config
}

export { resolve }
