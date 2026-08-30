import { AsyncLocalStorage } from 'node:async_hooks';

const requestDeadline = new AsyncLocalStorage();
export const UPSTREAM_TIMEOUT_MS = 8000;
export const REQUEST_TIMEOUT_MS = 24000;

export function withNetworkDeadline(operation) {
  return requestDeadline.run(AbortSignal.timeout(REQUEST_TIMEOUT_MS), operation);
}

export function networkSignal(originalSignal) {
  const signals = [AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)];
  const deadline = requestDeadline.getStore();
  if (deadline) signals.push(deadline);
  if (originalSignal) signals.push(originalSignal);
  return AbortSignal.any(signals);
}

export function boundedFetch(input, options = {}) {
  return fetch(input, {
    ...options,
    signal: networkSignal(options.signal || input?.signal),
  });
}
