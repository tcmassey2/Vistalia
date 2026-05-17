/// <reference types="vite/client" />

// Tells TypeScript about Vite's `import.meta.env` (BASE_URL, MODE, etc.).
// Required for any source file that reads `import.meta.env.*` — without
// this reference, tsc errors with: Property 'env' does not exist on
// type 'ImportMeta'. The reference is loaded once project-wide via this
// d.ts and applies everywhere.
