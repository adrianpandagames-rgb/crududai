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
