/**
 * Loads and validates the JSON catalogue once. Parsing through zod means a bad
 * hand-edit to /data fails loudly at startup instead of mid-plan.
 */
import { z } from "zod";
import citiesJson from "../data/cities.json";
import edgesJson from "../data/edges.json";
import eventsJson from "../data/events.json";
import experiencesJson from "../data/experiences.json";
import poisJson from "../data/pois.json";
import presetsJson from "../data/presets.json";
import restaurantsJson from "../data/restaurants.json";
import weightsJson from "../data/weights.json";
import {
  City, CityEdge, Event, Experience, Poi, PresetsFile, Restaurant, WeightsFile,
} from "./types";

export type Catalogue = {
  cities: City[];
  pois: Poi[];
  restaurants: Restaurant[];
  experiences: Experience[];
  edges: CityEdge[];
  events: Event[];
  presets: PresetsFile;
  weights: WeightsFile;
};

let cached: Catalogue | null = null;

export function loadCatalogue(): Catalogue {
  cached ??= {
    cities: z.array(City).parse(citiesJson),
    pois: z.array(Poi).parse(poisJson),
    restaurants: z.array(Restaurant).parse(restaurantsJson),
    experiences: z.array(Experience).parse(experiencesJson),
    edges: z.array(CityEdge).parse(edgesJson),
    events: z.array(Event).parse(eventsJson),
    presets: PresetsFile.parse(presetsJson),
    weights: WeightsFile.parse(weightsJson),
  };
  return cached;
}
