// Geodesic destinations keep the coverage radius in metres at any latitude.
export function destination(lat, lng, bearing, metres) {
  const radians = Math.PI / 180;
  const phi = lat * radians;
  const lambda = lng * radians;
  const theta = bearing * radians;
  const distance = metres / 6371008.8;
  const nextPhi = Math.asin(Math.sin(phi) * Math.cos(distance) + Math.cos(phi) * Math.sin(distance) * Math.cos(theta));
  const nextLambda = lambda + Math.atan2(Math.sin(theta) * Math.sin(distance) * Math.cos(phi), Math.cos(distance) - Math.sin(phi) * Math.sin(nextPhi));
  return [nextPhi / radians, ((nextLambda / radians + 540) % 360) - 180];
}

// `beamwidth` is the full opening in degrees, centred on the azimuth.
export function coverageSector(lat, lng, azimuth, radius = 500, beamwidth = 90) {
  const half = beamwidth / 2;
  const steps = Math.max(Math.ceil(beamwidth / 3), 2);
  const points = [[lat, lng]];
  for (let step = 0; step <= steps; step++) {
    points.push(destination(lat, lng, azimuth - half + (beamwidth * step) / steps, radius));
  }
  points.push([lat, lng]);
  return points;
}

// `percent` scales the colour's HSL saturation: 0 is grey, 100 leaves it unchanged, 200 doubles it (capped at full).
export function adjustSaturation(hex, percent) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) return hex;
  const value = parseInt(match[1], 16);
  const [r, g, b] = [value >> 16, (value >> 8) & 255, value & 255].map((channel) => channel / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const delta = max - min;
  let hue = 0;
  let sat = 0;
  if (delta) {
    sat = delta / (1 - Math.abs(2 * light - 1));
    hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  }
  const factor = Math.min(Math.max(Number(percent) || 0, 0), 200) / 100;
  const nextSat = Math.min(sat * factor, 1);
  const chroma = (1 - Math.abs(2 * light - 1)) * nextSat;
  const x = chroma * (1 - Math.abs((hue % 2 + 2) % 2 - 1));
  const m = light - chroma / 2;
  const sector = ((Math.floor(hue) % 6) + 6) % 6;
  const [r1, g1, b1] = [[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma], [chroma, 0, x]][sector];
  return `#${[r1, g1, b1].map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}
