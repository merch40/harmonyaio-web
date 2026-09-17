// The static H mark shared with the Harmony website.
export function handleFavicon(): Response {
  return new Response("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 48 48\"><rect width=\"48\" height=\"48\" rx=\"9\" fill=\"#0c0c0d\"/><path fill=\"#2dd4bf\" d=\"M11 11h10v2h-3v10h12V13h-3v-2h10v2h-3v22h3v2H27v-2h3V25H18v10h3v2H11v-2h3V13h-3z\"/></svg>", {
    headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
  });
}
