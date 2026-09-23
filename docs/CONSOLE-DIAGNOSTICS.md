# Console connection investigation

The VM **Mở console** action opens a dedicated CMP tab at `/console/:instanceId`, without the portal sidebar. The tab shares the existing authenticated CMP cookie session and obtains a fresh console session from the backend on load, refresh, or reconnect. Nova URLs and tokens are transport-only: they are never placed in the CMP route or offered as a navigation fallback. The existing CMP-owned RFB implementation is reused.

Console Input defaults to three lines and offers **Xoá nội dung** and **Type + Enter**. Normal characters use a fixed 50 ms delay; Enter retains its 100 ms delay. Multiline input preserves line breaks without appending a duplicate final Enter. Progress and cancellation remain available, and focus returns to VNC after successful typing. Commands stay in browser memory only. Leaving the page cancels typing and disposes the RFB session; returning from the browser back/forward cache starts a fresh session.

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
4. Compare the sanitized Nova response and derived WebSocket endpoint against the actual CMP WS request locally. Keep the token local. An expired/single-use token or competing viewer can invalidate a comparison; use CMP reconnect to request a fresh session. Do not add a raw Nova navigation fallback.
5. If the failure implicates a proxy or Nova origin validation, inspect the deployed configuration and redacted server logs before changing it. The repository nginx example handles CMP HTTP only; the current frontend connects directly to Nova.
6. After an evidence-supported correction, verify WS handshake acceptance, RFB connect, visible framebuffer and stability for 60 seconds. Test manual mouse/keyboard before Auto-Type; then test reconnect/close and input-state independence.

The local `OS_MOCK=true` service returns an illustrative URL, not a functioning VNC server. Its failure cannot establish the root cause of a production console failure. Do not report a successful production fix based on mock UI rendering or parser unit tests.
