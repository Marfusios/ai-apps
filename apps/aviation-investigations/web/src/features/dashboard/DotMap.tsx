import { useEffect, useRef } from 'react';
import type { DashboardResponse } from '../../../../shared/contracts/dashboard';
import { formatCount } from '../../lib/format';
import { useTheme } from '../../theme';

/** Dot colour per theme, read from the design tokens so the map follows Day and Night. */
function dotColor(canvas: HTMLCanvasElement): string {
  const blue = getComputedStyle(canvas).getPropertyValue('--blue').trim() || '#1F519A';
  return blue;
}

/**
 * Static dot map (no tiles): the projected points from the response, drawn on a
 * 1000×637 canvas scaled by CSS. Overlapping dots darken, which shows density.
 */
export function DotMap({ map, total }: { map: DashboardResponse['map']; total: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [theme] = useTheme();

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    ctx.clearRect(0, 0, map.width, map.height);
    ctx.globalAlpha = theme === 'night' ? 0.7 : 0.6;
    ctx.fillStyle = dotColor(canvas);
    for (const [x, y] of map.points) {
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [map, theme]);

  return (
    <div className="overflow-hidden rounded-badge border border-hairline bg-paper/60">
      <canvas
        ref={ref}
        width={map.width}
        height={map.height}
        role="img"
        aria-label={`Dot map of ${formatCount(map.points.length)} of ${formatCount(total)} cases in the lower 48 states`}
        className="block h-auto w-full"
      />
      <p className="sr-only">
        {formatCount(map.points.length)} cases are drawn on the lower 48 map. {formatCount(map.withoutCoordinates)} have no coordinates and{' '}
        {formatCount(map.outsideFrame)} are outside the lower 48.
      </p>
    </div>
  );
}
