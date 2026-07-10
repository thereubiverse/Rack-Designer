// Shim for 'server-only' used ONLY by vitest (see the alias in vitest.config.ts).
// There is no Next.js alias for this package: 'server-only' is a real dependency
// that resolves normally in the app. This shim exists purely so vitest/jsdom
// (which don't set the React Server Components environment) don't throw on import.
