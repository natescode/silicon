// SPDX-License-Identifier: MIT
// The strata loader's filesystem access lives in strataSource.ts so the
// browser build can swap it for an inlined copy (strataSource.browser.ts).
export { loadBuiltinStrata } from './strataSource'
