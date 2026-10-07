/* Forked from arcade-outreach-library · tool-call-lifecycle @ 1d4d7a7 · 2026-09-29
   Detached copy — local edits will not flow back, and upstream fixes will not
   flow here. */
/**
 * Third-party brand marks, as raw path data.
 *
 * Inlined rather than imported from an icon package, and rendered
 * monochrome rather than in brand colours. Two reasons:
 *
 *  - Portability. An artifact is one `<svg>` that has to survive being
 *    lifted into a blog post, a PDF renderer or a bare `.svg` file. A
 *    runtime dependency or an `<img src>` breaks that.
 *  - Colour is grammar here. Chartreuse means Arcade, violet means code
 *    you wrote, amber means the auth layer. Five brand palettes dropped
 *    into that would read as five more meanings.
 *
 * Marks are used nominatively, to name the service a tool call runs
 * against. Each is drawn in its own square box; `box` is the side length
 * the path data assumes, and `Mark` scales it to whatever size you ask for.
 *
 * Google, GitHub, Linear and Stripe are the paths published by
 * simple-icons (CC0). Slack is the geometry from Slack's own brand SVG,
 * which simple-icons no longer ships.
 */

export interface Brand {
  /** what to print next to the mark */
  label: string;
  /** side length of the square the path data is drawn in */
  box: number;
  /** one or more subpaths, all filled with the same colour */
  d: string[];
}

export const GOOGLE: Brand = {
  label: 'Google',
  box: 24,
  d: [
    'M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z',
  ],
};

export const SLACK: Brand = {
  label: 'Slack',
  box: 122.8,
  d: [
    'M25.8,77.6c0,7.1-5.8,12.9-12.9,12.9S0,84.7,0,77.6s5.8-12.9,12.9-12.9h12.9V77.6z',
    'M32.3,77.6c0-7.1,5.8-12.9,12.9-12.9s12.9,5.8,12.9,12.9v32.3c0,7.1-5.8,12.9-12.9,12.9s-12.9-5.8-12.9-12.9V77.6z',
    'M45.2,25.8c-7.1,0-12.9-5.8-12.9-12.9S38.1,0,45.2,0s12.9,5.8,12.9,12.9v12.9H45.2z',
    'M45.2,32.3c7.1,0,12.9,5.8,12.9,12.9s-5.8,12.9-12.9,12.9H12.9C5.8,58.1,0,52.3,0,45.2s5.8-12.9,12.9-12.9H45.2z',
    'M97,45.2c0-7.1,5.8-12.9,12.9-12.9s12.9,5.8,12.9,12.9s-5.8,12.9-12.9,12.9H97V45.2z',
    'M90.5,45.2c0,7.1-5.8,12.9-12.9,12.9s-12.9-5.8-12.9-12.9V12.9C64.7,5.8,70.5,0,77.6,0s12.9,5.8,12.9,12.9V45.2z',
    'M77.6,97c7.1,0,12.9,5.8,12.9,12.9s-5.8,12.9-12.9,12.9s-12.9-5.8-12.9-12.9V97H77.6z',
    'M77.6,90.5c-7.1,0-12.9-5.8-12.9-12.9s5.8-12.9,12.9-12.9h32.3c7.1,0,12.9,5.8,12.9,12.9s-5.8,12.9-12.9,12.9H77.6z',
  ],
};

export const GITHUB: Brand = {
  label: 'GitHub',
  box: 24,
  d: [
    'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  ],
};

export const LINEAR: Brand = {
  label: 'Linear',
  box: 24,
  d: [
    'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z',
  ],
};

export const STRIPE: Brand = {
  label: 'Stripe',
  box: 24,
  d: [
    'M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z',
  ],
};

/**
 * Microsoft's four squares. Needed because this deck contrasts an api-key
 * toolkit (Stripe) with an OAuth one, and Microsoft Teams is the OAuth side:
 * Entra issues JWT access tokens, so `oauth2.at` claims are actually present,
 * which is not true of a provider handing back an opaque token.
 */
export const MICROSOFT: Brand = {
  label: 'Microsoft',
  box: 24,
  d: [
    'M11.4 24H0V12.6h11.4V24zM24 24H12.6V12.6H24V24zM11.4 11.4H0V0h11.4v11.4zm12.6 0H12.6V0H24v11.4z',
  ],
};

/**
 * One mark, scaled out of its own box into `size` px at (x, y).
 *
 * Every brand ships its path data in a different square, so this is the only
 * place that knows about `box` — callers just ask for pixels.
 */
export function Mark({ brand, x, y, size, color }: {
  brand: Brand; x: number; y: number; size: number; color: string;
}) {
  const k = Math.round((size / brand.box) * 10000) / 10000;
  return (
    <g transform={`translate(${x},${y}) scale(${k})`} fill={color}>
      {brand.d.map((d) => <path key={d.slice(0, 24)} d={d} />)}
    </g>
  );
}
