/**
 * Inter-city transfers as visible segments (taxi to airport → check-in → flight
 * → taxi to hotel), and the assumed onward departure on the last day.
 *
 * We don't know the user's bookings, so every time here is an explicit
 * assumption, labelled "assumed — update to your booking" in the timeline.
 */
import type { City } from "../types";
import { fromMin } from "./time";
import type { Hop } from "./routeOrder";

export type TransferMode = "flight" | "train" | "road";
export type Segment = { kind: "to_gateway" | "at_gateway" | "in_vehicle" | "from_gateway"; start: number; end: number; title: string };

/** How long before departure to be at the airport / station. */
export const GATEWAY_LEAD_MIN: Record<TransferMode, number> = { flight: 120, train: 30, road: 0 };
const GATEWAY_OF: Record<TransferMode, "airport" | "rail" | null> = { flight: "airport", train: "rail", road: null };
const DEFAULT_ACCESS_MIN = 30;
const MIN_IN_VEHICLE_MIN = 30;
export const ASSUMED = "(assumed — update to your booking)";

export const gatewayWord = (mode: TransferMode) => (mode === "flight" ? "airport" : "station");
export const accessMin = (city: City, mode: TransferMode) => {
  const gw = GATEWAY_OF[mode];
  return gw ? city.gatewayAccessMin[gw] ?? DEFAULT_ACCESS_MIN : 0;
};

/** Leave the hotel at `leaveMin`; returns the segments and when you reach the next hotel. */
export function intercitySegments(hop: Hop, leaveMin: number, from: City, to: City): { segments: Segment[]; depMin: number; arriveHotelMin: number } {
  const mode = hop.edge.mode as TransferMode;
  if (mode === "road") {
    const end = leaveMin + hop.minutes;
    return {
      segments: [{ kind: "in_vehicle", start: leaveMin, end, title: `Private car ${from.name} → ${to.name}, leaving ${fromMin(leaveMin)} ${ASSUMED}` }],
      depMin: leaveMin,
      arriveHotelMin: end,
    };
  }
  const access = accessMin(from, mode);
  const egress = accessMin(to, mode);
  const lead = GATEWAY_LEAD_MIN[mode];
  // The edge's door-to-door time is authoritative; whatever isn't access, lead or egress is the ride itself.
  const ride = Math.max(MIN_IN_VEHICLE_MIN, hop.minutes - access - lead - egress);
  const atGateway = leaveMin + access;
  const dep = atGateway + lead;
  const arrGateway = dep + ride;
  const word = gatewayWord(mode);
  const vehicle = mode === "flight" ? "Flight" : "Train";
  return {
    segments: [
      { kind: "to_gateway", start: leaveMin, end: atGateway, title: `Taxi to ${from.name} ${word}` },
      { kind: "at_gateway", start: atGateway, end: dep, title: mode === "flight" ? "Check-in & security" : "At the station" },
      { kind: "in_vehicle", start: dep, end: arrGateway, title: `${vehicle} ${from.name} → ${to.name}, departs ${fromMin(dep)} ${ASSUMED}` },
      { kind: "from_gateway", start: arrGateway, end: arrGateway + egress, title: `Taxi from ${word} to hotel` },
    ],
    depMin: dep,
    arriveHotelMin: arrGateway + egress,
  };
}

/** Onward mode from the last base: fly if it has an airport, else train, else road. */
export function departureMode(city: City): TransferMode {
  if (city.gatewayFor.includes("airport")) return "flight";
  if (city.gatewayFor.includes("rail")) return "train";
  return "road";
}
