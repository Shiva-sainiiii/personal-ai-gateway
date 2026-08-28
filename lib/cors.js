import { NextResponse } from "next/server";

// This gateway is meant to be called from arbitrary external clients (a
// Telegram/WhatsApp bot, a mobile app shell, a different hosted site, etc.)
// — not just from pages served by this same Vercel deployment. Without CORS
// headers, browsers block those cross-origin calls before they even reach
// this code (a preflight OPTIONS request fails silently as "Failed to
// fetch"), even though the request would have worked fine.
//
// Access is still fully gated by the Authorization: Bearer <master key>
// check in each route — CORS only controls which *websites* are allowed to
// read the response in a browser, it doesn't skip auth.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

export function withCors(response) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

export function corsJson(body, init) {
  return withCors(NextResponse.json(body, init));
}

export function corsPreflight() {
  return withCors(new NextResponse(null, { status: 204 }));
}
