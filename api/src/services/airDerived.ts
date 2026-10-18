/**
 * Two figures worked out from a temperature and a relative humidity, so every tower gets them whatever sensor it has.
 * Both use the Magnus formula with the same constants as Home Assistant's own dew point helpers (17.62 and 243.12 °C),
 * so they agree with the "Tower 1/2 Fresh Air Dew Point" helpers there. They are calculated, not measured.
 */
const A = 17.62;
const B = 243.12;

const round1 = (n: number) => Math.round(n * 10) / 10;
const valid = (t: number, rh: number) => Number.isFinite(t) && Number.isFinite(rh) && rh > 0 && rh <= 100 && t > -45 && t < 60;

/** Dew point in °C: the temperature at which the air would be fully saturated and moisture starts to condense. */
export function dewPoint(t: number, rh: number): number | null {
  if (!valid(t, rh)) return null;
  const g = Math.log(rh / 100) + (A * t) / (B + t);
  return round1((B * g) / (A - g));
}

/** Moisture in the air (absolute humidity) in grams of water vapour per cubic metre of air. */
export function moisture(t: number, rh: number): number | null {
  if (!valid(t, rh)) return null;
  const vapourPressureHpa = (rh / 100) * 6.112 * Math.exp((A * t) / (B + t));
  return round1((216.7 * vapourPressureHpa) / (273.15 + t));
}
