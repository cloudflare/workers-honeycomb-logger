# 👷 Durable Objects Counter template

## NOTE: You must be using wrangler 1.16.0-durable-objects.rc.0 or newer to use this template

A template for kick starting a Cloudflare Workers project using:

- Durable Objects
- Modules (ES Modules to be specific)
- Rollup
- Wrangler

Worker code is in `src/`. The Durable Object `Counter` class is in `src/counter.mjs`, and the eyeball script is in `index.mjs`.

Rollup is configured to output a bundled ES Module to `dist/index.mjs`.

On your first publish, you must use `wrangler publish --new-class` to allow the Counter class to implement Durable Objects.
