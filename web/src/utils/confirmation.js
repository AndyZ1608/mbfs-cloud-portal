export function matchesExactConfirmation(typedValue, resourceName) {
  return typeof typedValue === 'string'
    && typeof resourceName === 'string'
    && typedValue === resourceName;
}
