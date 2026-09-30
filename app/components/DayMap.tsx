"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";

export type Stop = { n: number; name: string; lat: number; lng: number; kind: "activity" | "meal" };

/** Small per-day map with numbered stops (OpenStreetMap tiles, attributed). Loaded client-side only. */
export default function DayMap({ stops }: { stops: Stop[] }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let map: import("leaflet").Map | null = null;
    let cancelled = false;
    (async () => {
      const L = await import("leaflet");
      if (cancelled || !el.current || stops.length === 0) return;
      map = L.map(el.current, { scrollWheelZoom: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      const points = stops.map((s) => L.latLng(s.lat, s.lng));
      stops.forEach((s, i) => {
        L.marker(points[i], { icon: L.divIcon({ className: "", html: `<span class="stop-marker ${s.kind === "meal" ? "meal" : ""}">${s.n}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }) })
          .bindTooltip(`${s.n}. ${s.name}`)
          .addTo(map!);
      });
      if (points.length > 1) L.polyline(points, { color: "#0f766e", weight: 2, opacity: 0.6, dashArray: "4 6" }).addTo(map);
      map.fitBounds(L.latLngBounds(points).pad(0.25), { maxZoom: 15 });
    })();
    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [stops]);

  if (stops.length === 0) return <p className="text-sm text-slate-500">No mapped stops for this day.</p>;
  return <div ref={el} className="h-64 w-full overflow-hidden rounded-xl" aria-label="Map of the day's stops" />;
}
