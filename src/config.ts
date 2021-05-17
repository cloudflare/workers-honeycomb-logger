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

const defaultSampleRates: SampleRates = {
  '1xx': 1,
  '2xx': 1,
  '3xx': 1,
  '4xx': 1,
  '5xx': 1,
  exception: 1,
}

const configDefaults: ResolvedConfig = {
  acceptTraceContext: false,
  apiKey: '',
  dataset: '',
  data: {},
  redactRequestHeaders: ['authorization', 'cookie', 'referer'],
  redactResponseHeaders: ['set-cookie'],
  sampleRates: defaultSampleRates,
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
