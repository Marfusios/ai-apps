import { cx } from '../lib/cx';
import {
  FRAMES,
  layoutProfile,
  profileAccessibleName,
  profileCaption,
  type FlightProfileSize,
  type FlightProfileStep,
  RING_RADIUS,
  type ProfileLayout,
} from './flight-profile-layout';

export type { FlightProfileSize, FlightProfileStep } from './flight-profile-layout';

export interface FlightProfileProps {
  /** NTSB event-sequence steps in order. */
  steps: readonly FlightProfileStep[];
  /** `mini`: 96×28 for cards and strips. `full`: full width for the drawer and case page. */
  size: FlightProfileSize;
  /** Mini only: the mono "PHASE · DEFINING EVENT" caption beside the line (default on). */
  caption?: boolean;
  className?: string;
}

/**
 * Schematic flight profile (UI_DESIGN §2.5): blue solid up to the defining event,
 * an ink dot with a ring at it, ink dashes after it and an ✕ on impact. Not to
 * scale, and its accessible name says so.
 */
export function FlightProfile({ steps, size, caption = true, className }: FlightProfileProps) {
  const name = profileAccessibleName(steps);
  if (size === 'mini') {
    return (
      <span className={cx('inline-flex min-w-0 items-center gap-2.5', className)}>
        <ProfileSvg layout={layoutProfile(steps, FRAMES.mini)} name={name} className="h-7 w-24 shrink-0" />
        {caption && (
          <span aria-hidden="true" className="truncate font-mono text-label tracking-mono text-muted">
            {profileCaption(steps)}
          </span>
        )}
      </span>
    );
  }
  // The phone layout is drawn on a narrower frame so the mono labels keep their size.
  return (
    <div className={className}>
      <ProfileSvg layout={layoutProfile(steps, FRAMES.full)} name={name} className="hidden h-auto w-full sm:block" />
      <ProfileSvg layout={layoutProfile(steps, FRAMES.fullNarrow)} name={name} className="block h-auto w-full sm:hidden" />
    </div>
  );
}

function ProfileSvg({ layout, name, className }: { layout: ProfileLayout; name: string; className?: string }) {
  const { frame, defining } = layout;
  const full = frame.labels;
  const cross = full ? 4.5 : 2.4;
  return (
    <svg
      role="img"
      aria-label={name}
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      className={cx('overflow-visible', className)}
      data-profile={full ? 'full' : 'mini'}
    >
      <path
        d={`M${frame.padLeft / 2} ${frame.ground}H${frame.width - frame.padRight / 2}`}
        className="fill-none stroke-blue"
        strokeWidth={full ? 0.8 : 0.6}
        strokeDasharray={full ? '3 3' : '2 2'}
      />
      {layout.flown && (
        <path
          d={layout.flown}
          className="fill-none stroke-blue"
          strokeWidth={full ? 1.8 : 1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          data-segment="flown"
        />
      )}
      {layout.after && (
        <path
          d={layout.after}
          className="fill-none stroke-ink"
          strokeWidth={full ? 1.5 : 1.2}
          strokeDasharray={full ? '4 3' : '2 1.6'}
          data-segment="after"
        />
      )}
      {full && layout.origin && <circle cx={layout.origin.x} cy={layout.origin.y} r={3} className="fill-blue" />}
      {layout.impacts.map((p) => (
        <path
          key={`${p.x}-${p.y}`}
          d={`M${p.x - cross} ${p.y - cross}l${cross * 2} ${cross * 2}M${p.x + cross} ${p.y - cross}l${-cross * 2} ${cross * 2}`}
          className="fill-none stroke-ink"
          strokeWidth={full ? 1.5 : 1.2}
          strokeLinecap="round"
          data-mark="impact"
        />
      ))}
      {defining && (
        <g data-mark="defining">
          {!defining.impact && <circle cx={defining.x} cy={defining.y} r={full ? 4 : 2.6} className="fill-ink" />}
          <circle
            cx={defining.x}
            cy={defining.y}
            r={full ? RING_RADIUS : 4.4}
            className="fill-none stroke-ink"
            strokeWidth={full ? 0.8 : 0.7}
          />
          {full && defining.leader && (
            <path
              d={`M${defining.x} ${defining.leader.y1}V${defining.leader.y2}`}
              className="fill-none stroke-rule"
              strokeWidth={0.8}
              data-mark="leader"
            />
          )}
          {full && defining.label && (
            <text
              x={defining.labelX}
              y={defining.labelY}
              textAnchor="middle"
              fontSize={frame.eventSize}
              strokeWidth={3}
              strokeLinejoin="round"
              className="fill-ink stroke-raised font-sans font-bold [paint-order:stroke]"
            >
              {defining.label}
            </text>
          )}
        </g>
      )}
      {layout.labels.map((label, i) => (
        <text
          key={i}
          x={label.x}
          y={frame.ground + 17 + label.row * 11}
          textAnchor={label.anchor}
          fontSize={frame.labelSize}
          className="fill-muted font-mono"
        >
          {label.text}
        </text>
      ))}
    </svg>
  );
}
