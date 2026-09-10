/**
 * The ambient layer: a slow radar sweep and drifting orbs.
 *
 * Deliberately not a client component and deliberately not Framer: this is
 * decoration that never reacts to anything, so it costs nothing to hydrate and
 * runs entirely on the compositor. It is `pointer-events-none` and hidden from
 * assistive technology — there is no information here.
 */
export function Ambient() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* The sweep: a conic gradient rotated as a whole, one transform a frame. */}
      <div className="absolute left-1/2 top-[-30%] h-[140vh] w-[140vh] -translate-x-1/2">
        <div
          className="radar-sweep size-full rounded-full opacity-[0.32]"
          style={{
            animation: 'radar-sweep 28s linear infinite',
            background:
              'conic-gradient(from 0deg, transparent 0deg, transparent 268deg, rgba(156,53,240,0.28) 320deg, rgba(236,72,153,0.85) 357deg, transparent 360deg)',
            maskImage: 'radial-gradient(circle at center, black 4%, rgba(0,0,0,0.65) 40%, transparent 72%)',
            WebkitMaskImage:
              'radial-gradient(circle at center, black 4%, rgba(0,0,0,0.65) 40%, transparent 72%)',
          }}
        />
      </div>

      {/* Concentric range rings, so the sweep reads as a radar rather than a spinner. */}
      <div className="absolute left-1/2 top-[-30%] h-[140vh] w-[140vh] -translate-x-1/2 opacity-[0.10]">
        {[28, 46, 64, 82].map((size) => (
          <div
            key={size}
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/40"
            style={{ width: `${size}%`, height: `${size}%` }}
          />
        ))}
      </div>

      <div
        className="radar-orb absolute -left-[10%] top-[8%] size-[38rem] rounded-full blur-[120px]"
        style={{
          animation: 'orb-drift 34s ease-in-out infinite',
          background: 'radial-gradient(circle, rgba(156,53,240,0.30) 0%, transparent 70%)',
        }}
      />
      <div
        className="radar-orb absolute right-[-12%] top-[38%] size-[34rem] rounded-full blur-[120px]"
        style={{
          animation: 'orb-drift 41s ease-in-out infinite reverse',
          background: 'radial-gradient(circle, rgba(236,72,153,0.26) 0%, transparent 70%)',
        }}
      />
      <div
        className="radar-orb absolute bottom-[-14%] left-[34%] size-[30rem] rounded-full blur-[120px]"
        style={{
          animation: 'orb-drift 47s ease-in-out infinite',
          background: 'radial-gradient(circle, rgba(99,102,241,0.20) 0%, transparent 70%)',
        }}
      />

      {/* A fine grid, barely there, to give the glass something to sit on. */}
      <div
        className="absolute inset-0 opacity-[0.16]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
          maskImage: 'radial-gradient(ellipse at 50% 0%, black 0%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse at 50% 0%, black 0%, transparent 75%)',
        }}
      />
    </div>
  );
}
