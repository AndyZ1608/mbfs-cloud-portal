# Console connection investigation

The embedded CMP console remains the primary interface. On failure, **Mở console Nova gốc** opens the untouched Nova HTML URL for comparison. Close that reference tab before retrying CMP, so two viewers do not interfere. Each CMP reconnect obtains a fresh URL. The fallback URL stays in component memory only and is cleared on reconnect, successful connection, or unmount.

## Enable temporary development diagnostics

Run the backend in a non-production environment with `CMP_CONSOLE_DIAGNOSTICS=true`.
Run the Vite development server with `VITE_CONSOLE_DIAGNOSTICS=true`.
Both settings default to off; neither enables these traces in production builds/processes.

The backend records the sanitized Nova URL shape at the boundary where the response is forwarded unchanged. The browser records CMP origin/secure-context status, sanitized response and derived endpoint, mixed-content classification, and the five RFB events. noVNC internal logging stays disabled.

With diagnostics enabled, the native WebSocket is passed to noVNC 1.5 using its supported raw-channel constructor. This is the same socket used for display and keyboard input; no probe connection is created. Socket open/error/close events record handshake acceptance, close code, clean flag and whether RFB connected. Reason text, event objects, error messages, credentials, desktop name, arbitrary path segments, fragments and query values are never logged.

## Collect evidence in the failing environment

1. Open DevTools Network, enable Preserve log, select WS, then request a fresh CMP console. Record CMP origin, Nova and RFB URL shapes from the sanitized diagnostics.
2. Inspect the actual WS request locally. Record its status (101, 403, 404, etc.) or the exact browser network error. JavaScript's WebSocket API does **not** expose a failed HTTP handshake status. A close code of 1006 cannot distinguish DNS, TLS, routing, origin rejection or HTTP failure.
3. Record whether `ws_open` and `rfb_connect` occurred, then the close code/clean flag. If a close reason exists, inspect it locally and remove tokens before sharing it. Do not export raw HAR files, full request URLs, cookies or console tokens.
4. Use the original Nova fallback for the same issued URL and compare its actual WS scheme, hostname, port, path and query structure in Network. Keep the token local. An expired/single-use token or competing viewer can invalidate a comparison; repeat with fresh sessions if necessary.
5. If the failure implicates a proxy or Nova origin validation, inspect the deployed configuration and redacted server logs before changing it. The repository nginx example handles CMP HTTP only; the current frontend connects directly to Nova.
6. After an evidence-supported correction, verify WS handshake acceptance, RFB connect, visible framebuffer and stability for 60 seconds. Test manual mouse/keyboard before Auto-Type; then test reconnect/close and input-state independence.

The local `OS_MOCK=true` service returns an illustrative URL, not a functioning VNC server. Its failure cannot establish the root cause of a production console failure. Do not report a successful production fix based on mock UI rendering or parser unit tests.
