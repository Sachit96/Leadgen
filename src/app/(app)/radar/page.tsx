import { requireCtx } from '@/lib/auth/context';
import { radarSnapshot } from '@/lib/services/radar';
import { ControlRoom } from './control-room';

export const dynamic = 'force-dynamic';

/**
 * The control room.
 *
 * Ten stages, one screen, every number read from the database. The visual
 * language is deliberately louder than the rest of the app because this screen
 * is meant to be looked at from across a room rather than worked in — but it is
 * an instrument, not a poster: a stage that has not run reads zero, and a
 * conversion from an empty stage reads as unknown rather than 0%.
 */
export default async function RadarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireCtx('analytics:read');
  const params = await searchParams;
  const preset = typeof params.range === 'string' ? params.range : '30d';

  const snapshot = await radarSnapshot(ctx, preset);

  return (
    <>
      {/*
       * Loaded here rather than in the root layout: this is the only screen
       * that uses these faces, and the rest of the app deliberately runs on
       * system type. React hoists these into <head>. Both families have full
       * fallback stacks, so the page is correct before they land — and if the
       * network never serves them.
       */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      {/* eslint-disable @next/next/no-page-custom-font -- scoped on purpose: this is
          the only screen using these faces, and the rest of the app deliberately runs
          on system type. Loading them app-wide would restyle every other screen. */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap"
      />
      <link
        rel="stylesheet"
        href="https://api.fontshare.com/v2/css?f[]=clash-display@500,600&display=swap"
      />
      {/* eslint-enable @next/next/no-page-custom-font */}
      <ControlRoom snapshot={snapshot} preset={preset} />
    </>
  );
}
