# Third-Party Notices — Silicon Playground

The static playground bundle (`dist/index.html`) embeds the following
third-party open-source software. All are permissively licensed (MIT).

The Silicon compiler assembles WebAssembly with its own direct binary emitter
(including funcref/call_indirect), so the bundle does **not** include `wabt` or
`binaryen` (both Apache-2.0). `wabt` is marked external and only lazy-loaded by
the Node-side `watToWasm` helper, which the browser never calls; `binaryen` is
blocked by the build's dependency tripwire.

CodeMirror is loaded at runtime from a CDN (not bundled) and is MIT-licensed.

---

## ohm-js

Silicon's parser is built on Ohm.

```
The MIT License (MIT)

Copyright (c) 2014-2022 Alessandro Warth and the Ohm project contributors.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
