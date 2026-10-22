/**
 * The dashboard dot map's projection: a d3-style Albers equal-area conic (standard
 * parallels 29.5° and 45.5°, rotated to 96° W) fitted to the 1000×637 lower-48 frame
 * of `DashboardResponse.map`. Points are projected on the server, so the browser
 * draws pixels and never receives coordinates.
 */
import { MAP_FRAME } from '../../shared/contracts/dashboard.js';

const RAD = Math.PI / 180;

const LOWER_48 = { minLat: 24.3, maxLat: 49.5, minLon: -125.0, maxLon: -66.8 };

function albers(lon: number, lat: number): [number, number] {
  const phi0 = 29.5 * RAD;
  const phi1 = 45.5 * RAD;
  const sy0 = Math.sin(phi0);
  const n = (sy0 + Math.sin(phi1)) / 2;
  const c = 1 + sy0 * (2 * n - sy0);
  const r0 = Math.sqrt(c) / n;
  const raw = (lambda: number, phi: number): [number, number] => {
    const r = Math.sqrt(c - 2 * n * Math.sin(phi)) / n;
    return [r * Math.sin(lambda * n), r0 - r * Math.cos(lambda * n)];
  };
  const [cx, cy] = raw(-0.6 * RAD, 38.7 * RAD);
  const [x, y] = raw((lon + 96) * RAD, lat * RAD);
  const scale = 1180;
  return [MAP_FRAME.width / 2 + scale * (x - cx), MAP_FRAME.height / 2 - scale * (y - cy)];
}

/**
 * The frame position of a point, rounded to one decimal, or null when it lies
 * outside the lower 48 (Alaska, Hawaii, territories, open water) or the frame.
 */
export function projectLower48(lat: number, lon: number): [number, number] | null {
  const inside = lat >= LOWER_48.minLat && lat <= LOWER_48.maxLat && lon >= LOWER_48.minLon && lon <= LOWER_48.maxLon;
  if (!inside) return null;
  const [x, y] = albers(lon, lat);
  if (x < 0 || x > MAP_FRAME.width || y < 0 || y > MAP_FRAME.height) return null;
  return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
}
