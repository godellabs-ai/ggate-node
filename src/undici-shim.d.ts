// Node ships undici as the built-in `fetch` backend but exposes no type
// declarations for the bare "undici" specifier. We only reach for its `Agent`
// at runtime (dev-only: an insecure-TLS dispatcher for a self-signed Console),
// so an ambient `any` module is all the compiler needs.
declare module "undici";
