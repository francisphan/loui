// Loaded before the relay by its service (node -r). Debian 12's nodejs is
// version 18, which has no global `crypto` (Web Crypto became one in 19);
// the MCP SDK's HTTP transport uses it.
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
