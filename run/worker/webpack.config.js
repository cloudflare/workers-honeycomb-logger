require('dotenv').config()
const child_process = require('child_process')
const path = require('path')
const webpack = require('webpack')

function git(command) {
  return child_process.execSync(`git ${command}`, { encoding: 'utf8' }).trim()
}

const mode = process.env.NODE_ENV || 'production'

module.exports = {
  output: {
    filename: `worker.${mode}.js`,
    path: path.join(__dirname, 'dist'),
  },
  mode,
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
    plugins: [],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        options: {
          transpileOnly: true,
        },
      },
    ],
  },
  plugins: [
    new webpack.EnvironmentPlugin({
      GIT_VERSION: git('describe --always'),
      GIT_AUTHOR_DATE: git('log -1 --format=%aI'),
      ...process.env,
    }),
  ],
}
