import { NextResponse } from "next/server";
import { getStore } from "@/server/store";
import { getLimiter } from "@/server/limiter";
import { PSL_MODEL_VERSION } from "@/lib/psl/version";
import { expectedModelHash } from "@/server/attest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    time: new Date().toISOString(),
    model: PSL_MODEL_VERSION,
    modelHash: expectedModelHash(),
    storage: getStore().kind,
    limiter: getLimiter().kind,
  });
}
