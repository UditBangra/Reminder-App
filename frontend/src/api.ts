import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

export const API_BASE = `${process.env.EXPO_PUBLIC_BACKEND_URL}/api`;

const TOKEN_KEY = "remindly.token";

export async function saveToken(t: string) {
  await AsyncStorage.setItem(TOKEN_KEY, t);
}
export async function getToken(): Promise<string | null> {
  return AsyncStorage.getItem(TOKEN_KEY);
}
export async function clearToken() {
  await AsyncStorage.removeItem(TOKEN_KEY);
}

const REQUEST_TIMEOUT_MS = 15000;

/** Error thrown by apiFetch. `status` is the HTTP status, or 0 when the server wasn't reached. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
const NETWORK_ERROR_MSG = "Couldn't reach the server. Please check your connection and try again.";

// fetch with an abort-based timeout so a stalled request fails fast instead of hanging.
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function apiFetch<T = any>(
  path: string,
  opts: RequestInit & { auth?: boolean } = {}
): Promise<T> {
  const { auth = true, headers, ...rest } = opts;
  const finalHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...(headers as Record<string, string>),
  };
  if (auth) {
    const token = await getToken();
    if (token) finalHeaders.Authorization = `Bearer ${token}`;
  }
  const url = `${API_BASE}${path}`;
  const init: RequestInit = { ...rest, headers: finalHeaders };
  // Only auto-retry idempotent reads — retrying POST/PUT/DELETE could double-submit.
  const canRetry = (rest.method || "GET").toUpperCase() === "GET";

  let res: Response;
  try {
    res = await fetchWithTimeout(url, init);
  } catch {
    if (!canRetry) throw new ApiError(NETWORK_ERROR_MSG, 0);
    try {
      res = await fetchWithTimeout(url, init);
    } catch {
      throw new ApiError(NETWORK_ERROR_MSG, 0);
    }
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    // 503 — the backend's own "couldn't do X right now" messages (e.g. an OTP SMS
    // that failed to send) are written for users, so show them as is.
    if (res.status === 503 && body && typeof body.detail === "string") {
      throw new ApiError(body.detail, res.status);
    }
    // Other 5xx — never surface server/stack details to the user
    if (res.status >= 500) {
      throw new ApiError("Something went wrong on our end. Please try again in a moment.", res.status);
    }
    // 422 — input validation; the client validates first and shows specifics,
    // so this is just a friendly fallback rather than raw Pydantic field errors
    if (res.status === 422) {
      throw new ApiError("Please check the information you entered and try again.", res.status);
    }
    // Other 4xx — the backend's detail messages here are written to be user-facing
    let msg = "";
    if (body) {
      const detail = body.detail;
      if (typeof detail === "string") {
        msg = detail;
      } else if (Array.isArray(detail) && detail.length > 0) {
        msg = detail.map((e: any) => e?.msg || "Invalid value").join(". ");
      } else if (typeof body.message === "string") {
        msg = body.message;
      }
    }
    if (!msg) msg = "Request couldn't be completed. Please try again.";
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

export const isWeb = Platform.OS === "web";
