const { join } = require('path');

const Telemetry = require('./telemetry');
const NodeDb = require('./nodedb');
const CommandQueue = require('./queue');
const { makeDevice } = require('./device');
const { attachInbound } = require('./inbound');
const { startTelemetryPush } = require('./push');

// ES module, loaded dynamically (spec §10.1)
let meshcore;

const CONNECT_TIMEOUT_MS = 20000;
const ONLINE_THRESHOLD_SECS = 60 * 60 * 2;
// consecutive command timeouts before we declare the serial connection
// stale (seen after host USB suspend: fd stays open, no traffic, no
// 'disconnected' event) and force a reconnect
const STALL_THRESHOLD = 5;

module.exports = (app) => {
  const plugin = {};
  let connection;
  let device;
  let telemetry;
  let nodeDb;
  let queue;
  let alertChannelIdx = null;
  let stopPush;
  let retryTimer;
  let positionAdvertTimer;
  let crewPollTimer;
  let gnssFallbackTimer;
  let selfInfo;
  let contactRefreshPending = false;
  let stopping = false;
  let restartPlugin;
  const alertHistory = new Map(); // path:state -> last sent ms (alert storm damper)
  const unsubscribes = [];

  plugin.id = 'signalk-meshcore';
  plugin.name = 'MeshCore';
  plugin.description = 'Connect Signal K with the MeshCore LoRa mesh network';

  import('@liamcottle/meshcore.js')
    .then((lib) => {
      meshcore = lib;
      app.setPluginStatus('MeshCore library loaded');
    })
    .catch((e) => {
      app.setPluginError(`Failed to load MeshCore library: ${e.message}`);
    });

  // Synthetic MMSI for chartplotter display (populate_vessels): 98-prefix
  // means "craft associated with a parent ship"; 7 digits derived stably
  // from the node public key. Ported from upstream's nodeNum scheme.
  function syntheticMmsi(nodeKey) {
    const n = parseInt(nodeKey.slice(0, 8), 16) % 10000000;
    return `98${String(n).padStart(7, '0')}`;
  }

  // Context for a mesh node in the Signal K tree. Identity is the
  // contact public key (hex). Vessel association via "... DE CALLSIGN".
  function getNodeContext(nodeKey, node, settings) {
    const callsign = NodeDb.callsignOf(node);
    if (callsign && app.signalk && app.signalk.root && app.signalk.root.vessels) {
      if (node.mmsi) {
        return `vessels.urn:mrn:imo:mmsi:${node.mmsi}`;
      }
      const { vessels } = app.signalk.root;
      const callsignPath = Object.keys(vessels).find((vesselCtx) => {
        const vessel = vessels[vesselCtx];
        return vessel.communication
          && vessel.communication.callsignVhf === callsign;
      });
      if (callsignPath) {
        return `vessels.${callsignPath}`;
      }
      return null;
    }
    if (settings.communications && settings.communications.populate_vessels) {
      // Synthetic-MMSI vessel so chartplotters (Freeboard etc) draw it
      return `vessels.urn:mrn:imo:mmsi:${syntheticMmsi(nodeKey)}`;
    }
    return `meshcore.urn:meshcore:node:${nodeKey}`;
  }

  function nodeToSignalK(nodeKey, node, settings) {
    const context = getNodeContext(nodeKey, node, settings);
    if (!context) {
      return null;
    }
    const values = [
      { path: 'communication.meshcore.publicKey', value: nodeKey },
      { path: 'communication.meshcore.name', value: node.name },
    ];
    if (Number.isFinite(node.advLat) && Number.isFinite(node.advLon)) {
      values.push({
        path: 'navigation.position',
        value: { latitude: node.advLat, longitude: node.advLon },
      });
    }
    if (context.indexOf('meshcore.urn') === 0
      || context.indexOf(':98') !== -1) {
      // purely-mesh node: inject name (and synthetic mmsi) to "vesselify" it
      values.push({ path: '', value: { name: node.name } });
      if (context.indexOf(':98') !== -1) {
        values.push({ path: '', value: { mmsi: context.split(':').at(-1) } });
      }
    }
    app.handleMessage('signalk-meshcore', {
      context,
      updates: [
        {
          source: { label: 'signalk-meshcore', src: nodeKey.slice(0, 12) },
          timestamp: new Date().toISOString(),
          values,
        },
      ],
    });
    if (context.indexOf('vessels.urn:mrn:imo:mmsi:') === 0
      && context.indexOf(':98') === -1) {
      // remember real-AIS associations only, not synthetic MMSIs
      node.mmsi = context.split(':').at(-1); // eslint-disable-line no-param-reassign
    }
    return context;
  }

  function setStatus(settings) {
    const online = nodeDb ? nodeDb.onlineCount(ONLINE_THRESHOLD_SECS) : 0;
    app.setPluginStatus(
      `Connected to MeshCore node at ${settings.device.address}, ${online} nodes seen recently`,
    );
  }

  // "Favorites only": vesselify just the nodes the user has configured
  // (crew/dinghy/onboard), or DE-callsign nodes that merge into real AIS
  // targets — never the whole mesh.
  function isConfiguredNode(keyHex, settings) {
    return (settings.nodes || []).some(
      (n) => n.publicKey && n.publicKey.toLowerCase() === keyHex,
    );
  }

  async function refreshContacts(settings) {
    const contacts = await queue.run(() => connection.getContacts(), 'getContacts');
    contacts.forEach((contact) => {
      const { key, node } = nodeDb.updateFromContact(contact);
      if (settings.communications && settings.communications.populate_vessels
        && (isConfiguredNode(key, settings) || NodeDb.callsignOf(node))) {
        nodeToSignalK(key, node, settings);
      }
    });
    await nodeDb.save();
    setStatus(settings);
  }

  // Adverts arrive frequently on a busy mesh — coalesce refreshes.
  function scheduleContactRefresh(settings) {
    if (contactRefreshPending) {
      return;
    }
    contactRefreshPending = true;
    setTimeout(() => {
      contactRefreshPending = false;
      refreshContacts(settings)
        .catch((e) => app.error(`Contact refresh failed: ${e.message}`));
    }, 10000);
  }

  function subscribeSignalK(settings) {
    const windPaths = telemetry.wind;
    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self',
        subscribe: [
          { path: 'navigation.position', period: 60000 },
          { path: 'notifications.*', policy: 'instant' },
          { path: 'environment.outside.temperature', period: 1000 },
          { path: 'environment.outside.relativeHumidity', period: 1000 },
          { path: 'environment.outside.pressure', period: 1000 },
          { path: windPaths.directionPath, period: 1000 },
          { path: windPaths.speedPath, period: 1000 },
          { path: 'navigation.headingTrue', period: 1000 },
          { path: 'navigation.headingMagnetic', period: 1000 },
          { path: 'navigation.magneticVariation', period: 1000 },
          { path: 'electrical.batteries.house.voltage', period: 1000 },
          { path: 'electrical.batteries.house.current', period: 1000 },
          { path: 'electrical.batteries.house.capacity.stateOfCharge', period: 1000 },
          { path: 'navigation.anchor.distanceFromBow', period: 1000 },
          { path: 'environment.depth.belowSurface', period: 1000 },
        ],
      },
      unsubscribes,
      (subscriptionError) => {
        app.error(`Subscription error: ${subscriptionError}`);
      },
      (delta) => {
        if (!delta.updates) {
          return;
        }
        delta.updates.forEach((u) => {
          if (!u.values) {
            return;
          }
          const src = String(u.$source || (u.source && u.source.label) || '');
          u.values.forEach((v) => {
            if (v.path === 'navigation.position') {
              // ignore re-imports of our own position (e.g. a Venus GPS
              // bridge echoing Signal K back) — they would make a dead
              // position source look eternally fresh and disable the
              // radio-GNSS fallback
              if (src.indexOf('gps.signalk') !== -1 || src.indexOf(plugin.id) !== -1) {
                return;
              }
              telemetry.update(v.path, v.value);
              return;
            }
            if (v.path.indexOf('notifications.') === 0) {
              handleNotification(v, settings); // eslint-disable-line no-use-before-define
              return;
            }
            telemetry.update(v.path, v.value);
          });
        });
      },
    );
  }

  function crewKeys(settings) {
    return (settings.nodes || [])
      .filter((node) => node.role === 'crew' && node.publicKey)
      .map((node) => Uint8Array.from(Buffer.from(node.publicKey, 'hex')));
  }

  function handleNotification(v, settings) {
    if (!connection || !device) {
      return;
    }
    if (!settings.communications || !settings.communications.send_alerts) {
      return;
    }
    if (!v.value || !v.value.state || ['alarm', 'emergency'].indexOf(v.value.state) === -1) {
      return;
    }
    // Rate-limit repeats of the same condition (a flapping device alarm
    // generated 259 channel posts in one night in the field). Keyed on
    // path+state so an escalation still alerts immediately; MOB is never
    // suppressed.
    const isMob = v.path.indexOf('notifications.mob') === 0;
    const cooldownMin = settings.communications.alert_cooldown_minutes;
    const cooldownMs = 60000 * (cooldownMin === undefined ? 15 : cooldownMin);
    const alertKey = `${v.path}:${v.value.state}`;
    const lastSent = alertHistory.get(alertKey);
    if (!isMob && cooldownMs > 0 && lastSent && (Date.now() - lastSent) < cooldownMs) {
      return;
    }
    alertHistory.set(alertKey, Date.now());
    let text = v.value.message || v.path;
    if (v.path.indexOf('notifications.mob.') === 0 && v.value.position
      && Number.isFinite(v.value.position.latitude)) {
      // No waypoints in MeshCore — MOB degrades to a text alert with lat/lon
      const p = v.value.position;
      text = `MOB! ${text} ${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`;
    }
    const crew = crewKeys(settings);
    crew.reduce(
      (prev, member) => prev.then(() => device.sendText(text, member)),
      Promise.resolve(),
    ).catch((e) => app.error(`Failed to send alert: ${e.message}`));
    if (alertChannelIdx !== null) {
      device.sendChannelText(text, alertChannelIdx)
        .catch((e) => app.error(`Failed to post alert to channel: ${e.message}`));
    }
  }

  // Pull crew positions via per-contact telemetry polls (encrypted,
  // contact-to-contact — requires the crew node to grant telemetry
  // permission to this node). LPP_GPS carries the position.
  async function pollOneCrewPosition(key, settings) {
    const keyHex = Buffer.from(key).toString('hex');
    let telemetryResponse;
    try {
      telemetryResponse = await queue.run(
        () => connection.getTelemetry(key),
        'getTelemetry',
      );
    } catch (e) {
      app.debug(`Crew telemetry poll failed for ${keyHex.slice(0, 12)}: ${e && e.message ? e.message : String(e)}`);
      return;
    }
    const parsed = meshcore.CayenneLpp.parse(telemetryResponse.lppSensorData);
    const gps = parsed.find((item) => item.type === meshcore.CayenneLpp.LPP_GPS);
    const node = nodeDb.get(keyHex);
    if (gps && node && Number.isFinite(gps.value.latitude)) {
      node.advLat = gps.value.latitude;
      node.advLon = gps.value.longitude;
      node.seen = new Date();
      nodeToSignalK(keyHex, node, settings);
      app.debug(`Crew position from telemetry: ${node.name} ${gps.value.latitude},${gps.value.longitude}`);
    }
  }

  async function pollCrewPositions(settings) {
    await crewKeys(settings).reduce(
      (prev, key) => prev.then(() => pollOneCrewPosition(key, settings)),
      Promise.resolve(),
    );
    await nodeDb.save();
  }

  function startCrewPolling(settings) {
    if (!settings.communications || !settings.communications.poll_crew_positions) {
      return;
    }
    const intervalMs = 60000 * (settings.communications.crew_poll_interval_minutes || 5);
    crewPollTimer = setInterval(() => {
      pollCrewPositions(settings)
        .catch((e) => app.error(`Crew poll failed: ${e.message}`));
    }, intervalMs);
  }

  // When the boat's own position source goes stale (GPS off, N2K fault),
  // fall back to the radio's GNSS module via a local self-telemetry
  // query — serial only, no airtime. Injected positions loop back
  // through our subscription, so each successful poll refreshes the
  // freshness clock and the next poll waits out the max-age again.
  function startRadioGnssFallback(settings) {
    const comms = settings.communications || {};
    if (!comms.radio_gnss_fallback) {
      return;
    }
    if (!selfInfo || !selfInfo.publicKey) {
      app.error('Radio GNSS fallback disabled: could not read radio self info');
      return;
    }
    const prefix = selfInfo.publicKey.slice(0, 6);
    const maxAgeMs = 60000 * (comms.position_max_age_minutes || 5);
    gnssFallbackTimer = setInterval(async () => {
      if (telemetry.positionAt && (Date.now() - telemetry.positionAt) < maxAgeMs) {
        return;
      }
      try {
        const response = await device.getSelfTelemetry(prefix);
        const parsed = meshcore.CayenneLpp.parse(response.lppSensorData);
        const gps = parsed.find((item) => item.type === meshcore.CayenneLpp.LPP_GPS);
        if (!gps || !Number.isFinite(gps.value.latitude)) {
          return;
        }
        const pos = { latitude: gps.value.latitude, longitude: gps.value.longitude };
        telemetry.update('navigation.position', pos);
        if (telemetry.position !== pos) {
          return; // rejected (null island — radio GPS has no fix yet)
        }
        app.handleMessage(plugin.id, {
          updates: [{ values: [{ path: 'navigation.position', value: pos }] }],
        });
        app.debug(`Position from radio GNSS: ${pos.latitude},${pos.longitude}`);
      } catch (e) {
        app.debug(`Radio GNSS poll failed: ${e.message}`);
      }
    }, 60000);
  }

  function startPositionAdverts(settings) {
    if (!settings.communications || !settings.communications.send_position) {
      return;
    }
    const intervalMs = 60000 * (settings.communications.position_interval_minutes || 30);
    const tick = () => {
      const p = telemetry.position;
      if (!p || !Number.isFinite(p.latitude)) {
        app.debug('Position advert skipped: no vessel position yet');
        return;
      }
      // wire format: int32 microdegrees (spec §10.5)
      queue.run(
        () => connection.setAdvertLatLong(
          Math.round(p.latitude * 1e6),
          Math.round(p.longitude * 1e6),
        ),
        'setAdvertLatLong',
      )
        .then(() => queue.run(() => connection.sendZeroHopAdvert(), 'sendZeroHopAdvert'))
        .then(() => app.debug(`Position advert sent: ${p.latitude},${p.longitude}`))
        .catch((e) => app.error(`Position advert failed: ${e.message}`));
    };
    positionAdvertTimer = setInterval(tick, intervalMs);
    // first advert shortly after connect, once the position subscription
    // has had a chance to deliver
    setTimeout(tick, 90000).unref?.();
  }

  async function onConnected(settings) {
    app.debug('Connected to MeshCore device');
    queue = new CommandQueue(undefined, {
      stallThreshold: STALL_THRESHOLD,
      onStall: () => {
        if (stopping) {
          return;
        }
        app.error(`Radio unresponsive (${STALL_THRESHOLD} consecutive command timeouts), reconnecting`);
        restartPlugin();
      },
    });
    // device clock is bogus after power-cycle (spec §10.2)
    await queue.run(() => connection.syncDeviceTime(), 'syncDeviceTime');
    try {
      selfInfo = await queue.run(() => connection.getSelfInfo(10000), 'getSelfInfo');
    } catch (e) {
      selfInfo = null;
      app.debug(`getSelfInfo failed: ${e && e.message ? e.message : e}`);
    }

    device = makeDevice(connection, meshcore.Constants, queue, (s) => app.debug(s), {
      dmRetries: (settings.communications || {}).dm_retries,
      retryGapSeconds: (settings.communications || {}).dm_retry_gap_seconds,
    });

    await attachInbound(connection, meshcore.Constants, {
      settings,
      device,
      app,
      telemetry,
      queue,
      onChannelMessage: (m) => {
        app.debug(`Channel message [${m.channelIdx}] ${m.sender}: ${m.text}`);
      },
    });

    await refreshContacts(settings);

    // new adverts (auto-add mode) → refresh contact list into DB
    connection.on(meshcore.Constants.PushCodes.Advert, () => {
      scheduleContactRefresh(settings);
    });

    alertChannelIdx = null;
    if (settings.communications && settings.communications.alert_channel_name) {
      const alertChannel = await queue.run(
        () => connection.findChannelByName(settings.communications.alert_channel_name),
        'findAlertChannel',
      );
      if (alertChannel) {
        alertChannelIdx = alertChannel.channelIdx;
      } else {
        app.error(`Alert channel "${settings.communications.alert_channel_name}" not found on device`);
      }
    }

    if (settings.telemetry && settings.telemetry.enabled) {
      const channelName = settings.telemetry.channelName || 'BOAT-TELEM';
      const channel = await queue.run(
        () => connection.findChannelByName(channelName),
        'findChannelByName',
      );
      if (!channel) {
        app.setPluginError(`Telemetry channel "${channelName}" not found on device`);
      } else {
        const includeName = settings.telemetry.includeVesselName !== false;
        stopPush = startTelemetryPush({
          device,
          telemetry,
          channelIdx: channel.channelIdx,
          intervalMs: 60000 * (settings.telemetry.intervalMinutes || 10),
          vesselName: includeName
            ? (settings.telemetry.vesselName || app.getSelfPath('name'))
            : undefined,
          log: (s) => app.debug(s),
        });
      }
    }

    subscribeSignalK(settings);
    startPositionAdverts(settings);
    startCrewPolling(settings);
    startRadioGnssFallback(settings);
    setStatus(settings);
  }

  plugin.start = (settings, restart) => {
    if (!meshcore) {
      app.setPluginStatus('Waiting for MeshCore library to load');
      retryTimer = setTimeout(() => plugin.start(settings, restart), 100);
      return;
    }
    stopping = false;
    restartPlugin = () => restart(settings);
    telemetry = new Telemetry({ windSource: (settings.telemetry || {}).windSource });
    nodeDb = new NodeDb(join(app.getDataDirPath(), 'node-db.json'), (s) => app.debug(s));

    nodeDb.load()
      .then(() => {
        const transport = settings.device && settings.device.transport;
        const address = settings.device && settings.device.address;
        if (!address) {
          app.setPluginError('No device address configured');
          return;
        }
        // never start a new session with an old one possibly holding the
        // port (same-process serial locks are not re-entrant)
        if (connection) {
          try {
            connection.close();
          } catch (e) { /* already closed */ }
          connection = null;
        }
        if (transport === 'serial') {
          connection = new meshcore.NodeJSSerialConnection(address);
        } else {
          connection = new meshcore.TCPConnection(address, (settings.device.port || 5000));
        }

        // serial open failures only emit 'error' — enforce our own timeout,
        // and release the half-open port or the retry locks itself out
        const connectTimeout = setTimeout(() => {
          app.error(`Connect to ${address} timed out, retrying in 30s`);
          if (connection) {
            connection.close();
          }
          retryTimer = setTimeout(() => restart(settings), 30000);
        }, CONNECT_TIMEOUT_MS);

        // capture this session's connection: a superseded session's late
        // serial events (close straggling through USB teardown) must not
        // kill the session that replaced it
        const conn = connection;

        conn.on('connected', () => {
          if (conn !== connection) {
            // superseded session finished opening late (meshcore.js
            // close() is a no-op while open is in flight) — release the
            // port or the live session can never lock it
            try {
              conn.close();
            } catch (e) { /* already closed */ }
            return;
          }
          clearTimeout(connectTimeout);
          onConnected(settings).catch((e) => {
            // a failed startup leaves a half-initialized session — close
            // and retry like every other failure path, don't strand the plugin
            app.setPluginError(`Startup failed: ${e.message}, retrying in 30s`);
            if (connection) {
              connection.close();
            }
            if (!stopping) {
              retryTimer = setTimeout(() => restart(settings), 30000);
            }
          });
        });

        conn.on('disconnected', () => {
          if (stopping || conn !== connection) {
            return;
          }
          app.error('MeshCore device disconnected, restarting');
          restart(settings);
        });

        app.setPluginStatus(`Connecting to MeshCore node ${address}`);
        connection.connect()
          .catch((e) => {
            app.error(`Unable to connect: ${e.message}. Retrying in 30s`);
            retryTimer = setTimeout(() => restart(settings), 30000);
          });
      })
      .catch((e) => {
        app.error(`Unable to connect: ${e.message}. Retrying in 30s`);
        retryTimer = setTimeout(() => restart(settings), 30000);
      });
  };

  plugin.stop = () => {
    stopping = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
    }
    if (positionAdvertTimer) {
      clearInterval(positionAdvertTimer);
    }
    if (crewPollTimer) {
      clearInterval(crewPollTimer);
    }
    if (gnssFallbackTimer) {
      clearInterval(gnssFallbackTimer);
    }
    if (stopPush) {
      stopPush();
      stopPush = null;
    }
    unsubscribes.forEach((f) => f());
    unsubscribes.length = 0;
    if (connection) {
      connection.close();
      connection = null;
    }
  };

  plugin.schema = () => {
    function nodeList() {
      if (!nodeDb || Object.keys(nodeDb.nodes).length === 0) {
        return undefined;
      }
      return Object.keys(nodeDb.nodes).map((key) => ({
        const: key,
        title: `${nodeDb.nodes[key].name || key.slice(0, 12)}`,
      }));
    }
    return {
      type: 'object',
      properties: {
        device: {
          type: 'object',
          title: 'MeshCore device connection',
          properties: {
            transport: {
              type: 'string',
              default: 'serial',
              title: 'How to connect to the boat MeshCore companion radio',
              oneOf: [
                { const: 'serial', title: 'USB serial (companion_radio_usb firmware; address = device path)' },
                { const: 'tcp', title: 'TCP/WiFi (companion_radio_wifi firmware; address = host)' },
              ],
            },
            address: {
              type: 'string',
              title: 'Serial device path or TCP host',
            },
            port: {
              type: 'integer',
              default: 5000,
              title: 'TCP port',
            },
          },
        },
        nodes: {
          type: 'array',
          title: 'Known MeshCore nodes',
          minItems: 0,
          items: {
            type: 'object',
            required: ['publicKey', 'role'],
            properties: {
              publicKey: {
                type: 'string',
                title: 'Node (public key)',
                oneOf: nodeList(),
              },
              role: {
                type: 'string',
                title: 'Role',
                oneOf: [
                  { const: 'crew', title: 'Node carried by crew member' },
                  { const: 'dinghy', title: 'Dinghy tracker node' },
                  { const: 'onboard', title: 'Onboard equipment' },
                ],
              },
            },
          },
        },
        communications: {
          type: 'object',
          title: 'Communications',
          properties: {
            send_position: {
              type: 'boolean',
              title: 'Publish vessel position via MeshCore adverts',
              default: true,
            },
            position_interval_minutes: {
              type: 'integer',
              title: 'Position advert interval (minutes)',
              default: 30,
            },
            send_alerts: {
              type: 'boolean',
              title: 'Send alarm/emergency notifications to crew nodes',
              default: true,
            },
            alert_channel_name: {
              type: 'string',
              title: 'Also post alerts to this MeshCore channel (empty = off)',
              default: '',
            },
            alert_cooldown_minutes: {
              type: 'integer',
              title: 'Minimum minutes between repeats of the same alert (0 = send every one; escalations and MOB always send)',
              default: 15,
            },
            dm_retries: {
              type: 'integer',
              title: 'Automatic retries for unconfirmed direct messages (0 = no retries)',
              default: 1,
            },
            dm_retry_gap_seconds: {
              type: 'integer',
              title: 'Seconds between retries (spacing rides out RF fade windows)',
              default: 5,
            },
            reply_delay_seconds: {
              type: 'integer',
              title: 'Delay command replies (seconds) so they don\'t collide with the inbound exchange\'s RF wake on multi-hop links (0 = reply immediately)',
              default: 3,
            },
            digital_switching: {
              type: 'boolean',
              title: 'Allow crew to operate digital switching by message ("turn decklight on")',
              default: false,
            },
            populate_vessels: {
              type: 'boolean',
              title: 'Show configured nodes (crew/dinghy/onboard) as vessels in Signal K (Freeboard etc)',
              default: false,
            },
            poll_crew_positions: {
              type: 'boolean',
              title: 'Poll crew nodes for position via telemetry requests (crew must grant telemetry permission to this node)',
              default: false,
            },
            crew_poll_interval_minutes: {
              type: 'integer',
              title: 'Crew position poll interval (minutes)',
              default: 5,
            },
            radio_gnss_fallback: {
              type: 'boolean',
              title: 'Use the radio\'s own GNSS for vessel position when the boat source goes stale (requires a GPS module on the radio)',
              default: false,
            },
            position_max_age_minutes: {
              type: 'integer',
              title: 'Boat position considered stale after (minutes)',
              default: 5,
            },
          },
        },
        telemetry: {
          type: 'object',
          title: 'Telemetry bot',
          properties: {
            enabled: {
              type: 'boolean',
              title: 'Push telemetry line to a MeshCore channel',
              default: false,
            },
            channelName: {
              type: 'string',
              title: 'Telemetry channel name (must exist on the radio; do NOT use Public)',
              default: 'BOAT-TELEM',
            },
            intervalMinutes: {
              type: 'integer',
              title: 'Push interval (minutes)',
              default: 10,
            },
            includeVesselName: {
              type: 'boolean',
              title: 'Prefix the telemetry line with the vessel name',
              default: true,
            },
            vesselName: {
              type: 'string',
              title: 'Vessel name tag for the telemetry line (defaults to the vessel name in Signal K)',
            },
            windSource: {
              type: 'string',
              title: 'Wind data source (labels follow: true=Wd/Ws, apparent=Wa/Wsa)',
              default: 'true',
              oneOf: [
                { const: 'true', title: 'True wind (environment.wind.directionTrue / speedOverGround)' },
                { const: 'apparent', title: 'Apparent wind (environment.wind.angleApparent / speedApparent)' },
              ],
            },
          },
        },
        switches: {
          type: 'array',
          title: 'Digital switch name → Signal K path mapping',
          minItems: 0,
          items: {
            type: 'object',
            required: ['name', 'path'],
            properties: {
              name: { type: 'string', title: 'Switch name used in messages' },
              path: {
                type: 'string',
                title: 'Signal K path (e.g. electrical.switches.bank.0.4.state)',
              },
            },
          },
        },
      },
    };
  };

  return plugin;
};
