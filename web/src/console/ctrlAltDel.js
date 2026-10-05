// Send the guest secure-attention chord through the active noVNC connection.
export function canSendConsoleCtrlAltDel({ connected, typing = false, coolingDown = false }) {
  return connected && !typing && !coolingDown;
}

export function sendConsoleCtrlAltDel(rfb, state) {
  if (!canSendConsoleCtrlAltDel(state)) return false;
  if (typeof rfb?.sendCtrlAltDel !== 'function') throw new Error('RFB session unavailable');
  rfb.sendCtrlAltDel();
  return true;
}
