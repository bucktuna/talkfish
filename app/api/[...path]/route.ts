import { handleApi } from "@/lib/http/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleApi(request);
}

export function POST(request: Request) {
  return handleApi(request);
}
