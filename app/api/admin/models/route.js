import { NextResponse } from "next/server";
import { requireAdmin, requireMasterKey } from "../../../../lib/auth.js";
import { allModelsByProvider } from "../../../../lib/modelRegistry.js";
import { PROVIDERS } from "../../../../lib/providers.js";

export const runtime = "nodejs";

// GET /api/admin/models — every (provider, model) pair the gateway knows
// how to call, for the manual test-page provider/model picker. Also flags
// each provider's `kind` (text/image/mixed) so the picker can hide models
// that don't apply to whichever test type (text/image/audio) is selected.
//
// Auth: admin password OR any master key — see the matching note in
// test-history/route.js. This endpoint only returns model *names* (no
// credentials), so accepting a master key here is low-risk and lets the
// Test page populate its picker without a second admin login.
export async function GET(req) {
  const adminAuth = await requireAdmin(req);
  if (!adminAuth.ok) {
    const asText = await requireMasterKey(req, "text");
    const asImage = asText.ok ? asText : await requireMasterKey(req, "image");
    const asAudio = asImage.ok ? asImage : await requireMasterKey(req, "audio");
    if (!asAudio.ok) {
      return NextResponse.json({ error: "Requires admin password or a valid master key." }, { status: 401 });
    }
  }

  const modelsByProvider = allModelsByProvider(PROVIDERS);
  const providerKinds = Object.fromEntries(Object.entries(PROVIDERS).map(([name, p]) => [name, p.kind]));

  return NextResponse.json({ modelsByProvider, providerKinds });
}
