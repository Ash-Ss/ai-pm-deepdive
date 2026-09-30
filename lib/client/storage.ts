/** The current trip in localStorage. Every access is guarded: storage can be missing, full or blocked. */
const KEY = "mh-trip-planner:v1";

export function loadState<T>(): T | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveState<T>(state: T): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Quota or privacy mode: the app still works, it just won't remember the trip.
  }
}

export function clearState(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
