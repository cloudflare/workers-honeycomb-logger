# Introduction

`workers-honeycomb-logger` is a simple library that you wrap your listener, configure with an Honeycomb API key and dataset, and it will automatically send every request to be logged in Honeycomb, where you can easily query, graph and monitor your workers from there.

⚠️`workers-honeycomb-logger` is currently in beta. We do not recommend using it for production workloads just yet. ⚠️

It currently only supports workers that have exactly one `EventListener` that always returns a `Response`. And we currently also support at most one `waitUntill` call. If your worker does not return a Response (to have an origin handle the request for example) or you use multiple `waitUntill()` calls, installing this will change the behaviour of your worker. (And probably for the worse). These are known issue that we will fix before doing a non-beta release.
