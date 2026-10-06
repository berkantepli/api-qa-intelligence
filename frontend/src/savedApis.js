// Removes a saved API and decides which API becomes active next.
// Run history is intentionally left untouched: runs are evidence and stay reviewable.
export function removeSavedApi(savedApis, apiId, activeApiId) {
  const remaining = savedApis.filter((api) => api.id !== apiId);
  if (apiId !== activeApiId) return { remaining, nextActiveApi: undefined, activeChanged: false };
  const removedIndex = savedApis.findIndex((api) => api.id === apiId);
  const nextActiveApi = remaining[Math.min(Math.max(removedIndex, 0), remaining.length - 1)];
  return { remaining, nextActiveApi, activeChanged: true };
}
