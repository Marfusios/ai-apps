import { useEffect, useRef } from 'react';
import type { DashboardResponse } from '../../../../shared/contracts/dashboard';
import { formatCount } from '../../lib/format';

/** Dot colour and alpha from the design tokens, so the map follows Day, Night and print. */
function dotStyle(canvas: HTMLCanvasElement): { color: string; alpha: number } {
  const style = getComputedStyle(canvas);
  const alpha = Number.parseFloat(style.getPropertyValue('--map-dot-alpha'));
  return { color: style.getPropertyValue('--map-dot').trim() || '#1F519A', alpha: Number.isFinite(alpha) ? alpha : 0.6 };
}

/**
 * Static dot map (no tiles): the projected points from the response, drawn on a
 * 1000×637 canvas scaled by CSS. Overlapping dots darken, which shows density.
 * It redraws when `data-theme` changes, reading the tokens after the attribute is set.
 */
export function DotMap({ map, total }: { map: DashboardResponse['map']; total: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = (): void => {
      let ctx: CanvasRenderingContext2D | null = null;
      try {
        ctx = canvas.getContext('2d');
      } catch {
        ctx = null;
      }
      if (!ctx) return;
      const { color, alpha } = dotStyle(canvas);
      ctx.clearRect(0, 0, map.width, map.height);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      for (const [x, y] of map.points) {
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    draw();
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [map]);

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
