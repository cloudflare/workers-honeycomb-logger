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

interface ParentSpanInfo {
  trace_id: string
  parent_id: string
  sampled?: boolean
}

export interface TraceHeaders {
  traceparent: string
  tracestate?: string
}

const byteToHex: string[] = []
const TRACE_PARENT_REGEX = /^[\dabcdef]{2}-([\dabcdef]{32})-([\dabcdef]{16})-(([\dabcdef]{2}))/

for (let n = 0; n <= 0xff; ++n) {
  const hexOctet = n.toString(16).padStart(2, '0')
  byteToHex.push(hexOctet)
}

function generateId(length: number): string {
  const buffer = new Uint8Array(length / 2)
  crypto.getRandomValues(buffer)
  const hex = new Array(buffer.length)
  for (let i = 0; i < buffer.length; ++i) hex[i] = byteToHex[buffer[i]]

  return hex.join('').toLowerCase()
}

function parseTraceParentHeader(header: string): ParentSpanInfo | undefined {
  const match = TRACE_PARENT_REGEX.exec(header.trim())
  if (match) {
    return {
      trace_id: match[1],
      parent_id: match[2],
      sampled: match[3] === '01',
    }
  }
}

export class TraceContext {
  public readonly version: number = 0
  public readonly trace_id: string
  public readonly parent_id?: string
  public readonly span_id: string
  public sampled: boolean = true
  protected constructor(parent?: ParentSpanInfo) {
    this.span_id = generateId(16)
    if (parent) {
      this.trace_id = parent.trace_id
      this.parent_id = parent.parent_id
      if (parent.sampled !== undefined) {
        this.sampled = parent.sampled
      }
    } else {
      this.trace_id = generateId(32)
    }
  }

  static newTraceContext(request?: Request): TraceContext {
    if (request) {
      const trace_parent = request.headers.get('traceparent')
      if (trace_parent) {
        const parentInfo = parseTraceParentHeader(trace_parent)
        return new TraceContext(parentInfo)
      }
    }
    return new TraceContext()
  }

  getChildContext(): TraceContext {
    return new TraceContext({
      trace_id: this.trace_id,
      parent_id: this.span_id,
      sampled: this.sampled,
    })
  }

  getHeaders(): TraceHeaders {
    return {
      traceparent: `00-${this.trace_id}-${this.span_id}-${this.sampled ? '01' : '00'}`,
    }
  }
}
