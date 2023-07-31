// plugin-node-resolve and plugin-commonjs are required for a rollup bundled project
// to resolve dependencies from node_modules. See the documentation for these plugins
// for more details.
import dotenv from 'dotenv'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import replace from '@rollup/plugin-replace'

dotenv.config()

const replace_plugin = replace({
  __HONEYCOMB_API_KEY__: process.env.HONEYCOMB_API_KEY,
  preventAssignment: true,
})

export default {
  input: 'src/index.mjs',
  output: {
    exports: 'named',
    format: 'es',
    file: 'dist/index.mjs',
    sourcemap: true,
  },
  plugins: [commonjs(), nodeResolve({ browser: true }), replace_plugin],
}
