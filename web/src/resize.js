export function canStartResize(server, pending = false) {
  return !pending && !server?.['OS-EXT-STS:task_state']
    && (server?.status === 'ACTIVE' || server?.status === 'SHUTOFF');
}

export function canFinalizeResize(server, pending = false) {
  return !pending && server?.status === 'VERIFY_RESIZE';
}

export function validResizeFlavor(flavorRef, currentFlavorId, flavors) {
  return Boolean(flavorRef) && flavorRef !== currentFlavorId
    && flavors.some((flavor) => flavor.id === flavorRef);
}

// Keep the guard set after success until the modal unmounts; a second click cannot
// send another Nova request while React is committing the accepted state.
export async function submitResizeOnce({ pending, server, flavorRef, currentFlavorId, flavors, request, onStart, onAccepted, onError }) {
  if (pending.current || !validResizeFlavor(flavorRef, currentFlavorId, flavors)) return false;
  pending.current = true;
  onStart();
  try {
    await request(`/servers/${encodeURIComponent(server.id)}/action`, {
      method: 'POST', body: { action: 'resize', flavorRef },
    });
  } catch (error) {
    pending.current = false;
    onError(error);
    return false;
  }
  onAccepted();
  return true;
}
