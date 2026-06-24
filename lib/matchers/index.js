// Routes a "match" source URL (DRM service) to the right resolver.
// Each resolver returns { kind, sourcePlatform, tracks: [...], name? }.

import { resolveSpotify } from "./spotify.js";
import { resolveTidal } from "./tidal.js";
import { resolveQobuz } from "./qobuz.js";
import { resolveApple } from "./appleMusic.js";

const RESOLVERS = {
  spotify: resolveSpotify,
  tidal: resolveTidal,
  qobuz: resolveQobuz,
  apple: resolveApple,
};

export async function resolveMatch(platform, url) {
  const resolver = RESOLVERS[platform];
  if (!resolver) throw new Error(`No resolver for platform "${platform}".`);
  return resolver(url);
}
