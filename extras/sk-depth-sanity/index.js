// sk-depth-sanity — null out garbage depth values before they enter the
// Signal K data model.
//
// Why: the Raymarine depth instrument (N2K src 111) emits raw 0xFFFFFFFC in
// PGN 128267 when the sounder loses bottom lock. canboat nulls the standard
// sentinels (0xFFFFFFFF not-available, 0xFFFFFFFE error) but this variant
// slips through as 42,949,672.92 m (~140 million ft), which then reaches
// every consumer (displays, dashboard, alerts). Field incident 2026-07-26.
//
// Fix: registerDeltaInputHandler intercepts every incoming delta; any
// environment.depth.* numeric value above the plausibility limit is
// rewritten to null ("no reading"), which is what the instrument meant.
//
// Local boat infrastructure — deliberately not part of signalk-meshcore.

module.exports = (app) => {
  let active = false;
  let limit = 1000;
  let registered = false;

  // Pure so it can be tested without a server.
  const filterDelta = (delta, max) => {
    let nulled = 0;
    if (delta && Array.isArray(delta.updates)) {
      delta.updates.forEach((u) => {
        if (Array.isArray(u.values)) {
          u.values.forEach((v) => {
            if (v && typeof v.path === 'string'
              && v.path.indexOf('environment.depth.') === 0
              && typeof v.value === 'number' && v.value > max) {
              v.value = null;
              nulled += 1;
            }
          });
        }
      });
    }
    return nulled;
  };

  const plugin = {
    id: 'sk-depth-sanity',
    name: 'Depth sanity filter',

    start: (settings) => {
      limit = (settings && typeof settings.maxDepthMeters === 'number')
        ? settings.maxDepthMeters : 1000;
      active = true;
      // The server offers no unregister — install the handler once and
      // gate it on `active` so disable/stop turns it into a passthrough.
      if (!registered) {
        registered = true;
        app.registerDeltaInputHandler((delta, next) => {
          if (active) {
            const n = filterDelta(delta, limit);
            if (n) {
              app.debug(`Nulled ${n} implausible depth value(s) (> ${limit} m)`);
            }
          }
          next(delta);
        });
      }
      app.setPluginStatus(`Filtering environment.depth.* > ${limit} m`);
    },

    stop: () => {
      active = false;
    },

    schema: () => ({
      type: 'object',
      properties: {
        maxDepthMeters: {
          type: 'number',
          title: 'Maximum plausible depth (m) — larger values become null',
          description: 'Recreational transducers read a few hundred metres at most; the Raymarine garbage sentinel is ~42,949,673 m.',
          default: 1000,
        },
      },
    }),
  };

  plugin.filterDelta = filterDelta; // exposed for testing
  return plugin;
};
