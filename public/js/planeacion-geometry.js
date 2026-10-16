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

export function coverageSector(lat, lng, azimuth, radius = 500) {
  const points = [[lat, lng]];
  for (let angle = azimuth - 45; angle <= azimuth + 45; angle += 3) {
    points.push(destination(lat, lng, angle, radius));
  }
  points.push([lat, lng]);
  return points;
}
