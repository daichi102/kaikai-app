import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/client";

const THRESHOLDS = {
  washing_machine: 27,
  refrigerator: 19,
  microwave: null,
} as const;

export async function GET() {
  try {
    const supabase = createSupabaseServiceClient();

    const { data, error } = await supabase
      .from("appliance_slips")
      .select("appliance_category", { count: "exact" })
      .eq("status", "stored");

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const counts = {
      washing_machine: 0,
      refrigerator: 0,
      microwave: 0,
    };

    for (const row of data ?? []) {
      const category = row.appliance_category as keyof typeof counts;
      if (category in counts) {
        counts[category] += 1;
      }
    }

    return NextResponse.json({
      ok: true,
      counts,
      thresholds: THRESHOLDS,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unexpected error" },
      { status: 500 },
    );
  }
}
