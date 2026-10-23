export function allocationPercentage(allocated, allocatable) {
  if (!Number.isFinite(allocated) || !Number.isFinite(allocatable) || allocatable <= 0) return null;
  return 100 * allocated / allocatable;
}
