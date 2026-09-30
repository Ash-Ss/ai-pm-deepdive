"use client";

import dynamic from "next/dynamic";

/**
 * The planner keeps its state in the browser (localStorage), so it renders on the
 * client only — no server/client mismatch and no flash of the empty form.
 */
const TripPlanner = dynamic(() => import("./TripPlanner"), {
  ssr: false,
  loading: () => <div className="mx-auto mt-24 h-8 w-48 animate-pulse rounded-lg bg-slate-200" aria-label="Loading" />,
});

export default function ClientApp() {
  return <TripPlanner />;
}
