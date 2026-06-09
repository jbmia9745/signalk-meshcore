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

module.exports = (app) => {
  const plugin = {};
  let connection;
  let device;
  let telemetry;
  let nodeDb;
  let queue;
  let stopPush;
  let retryTimer;
  let positionAdvertTimer;
  let contactRefreshPending = false;
  let stopping = false;
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

  // Context for a mesh node in the Signal K tree. Identity is the
  // contact public key (hex). Vessel association via "... DE CALLSIGN".
  function getNodeContext(nodeKey, node) {
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
    return `meshcore.urn:meshcore:node:${nodeKey}`;
  }

  function nodeToSignalK(nodeKey, node) {
    const context = getNodeContext(nodeKey, node);
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
    if (context.indexOf('meshcore.urn') === 0) {
      values.push({ path: '', value: { name: node.name } });
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
    if (context.indexOf('vessels.urn:mrn:imo:mmsi:') === 0) {
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

  async function refreshContacts(settings) {
    const contacts = await queue.run(() => connection.getContacts(), 'getContacts');
    contacts.forEach((contact) => {
      const { key, node } = nodeDb.updateFromContact(contact);
      if (settings.communications && settings.communications.populate_vessels) {
        nodeToSignalK(key, node);
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
          { path: 'navigation.position', period: 600000 },
          { path: 'notifications.*', policy: 'instant' },
          { path: 'environment.outside.temperature', period: 1000 },
          { path: 'environment.outside.relativeHumidity', period: 1000 },
          { path: 'environment.outside.pressure', period: 1000 },
          { path: windPaths.directionPath, period: 1000 },
          { path: windPaths.speedPath, period: 1000 },
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
          u.values.forEach((v) => {
            if (v.path === 'navigation.position') {
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
    const crew = crewKeys(settings);
    if (!crew.length) {
      return;
    }
    let text = v.value.message || v.path;
    if (v.path.indexOf('notifications.mob.') === 0 && v.value.position
      && Number.isFinite(v.value.position.latitude)) {
      // No waypoints in MeshCore — MOB degrades to a text alert with lat/lon
      const p = v.value.position;
      text = `MOB! ${text} ${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`;
    }
    crew.reduce(
      (prev, member) => prev.then(() => device.sendText(text, member)),
      Promise.resolve(),
    ).catch((e) => app.error(`Failed to send alert: ${e.message}`));
  }

  function startPositionAdverts(settings) {
    if (!settings.communications || !settings.communications.send_position) {
      return;
    }
    const intervalMs = 60000 * (settings.communications.position_interval_minutes || 30);
    positionAdvertTimer = setInterval(() => {
      const p = telemetry.position;
      if (!p || !Number.isFinite(p.latitude)) {
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
        .catch((e) => app.error(`Position advert failed: ${e.message}`));
    }, intervalMs);
  }

  async function onConnected(settings) {
    app.debug('Connected to MeshCore device');
    queue = new CommandQueue();
    // device clock is bogus after power-cycle (spec §10.2)
    await queue.run(() => connection.syncDeviceTime(), 'syncDeviceTime');

    device = makeDevice(connection, meshcore.Constants, queue);

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
    setStatus(settings);
  }

  plugin.start = (settings, restart) => {
    if (!meshcore) {
      app.setPluginStatus('Waiting for MeshCore library to load');
      retryTimer = setTimeout(() => plugin.start(settings, restart), 100);
      return;
    }
    stopping = false;
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

        connection.on('connected', () => {
          clearTimeout(connectTimeout);
          onConnected(settings).catch((e) => {
            app.setPluginError(`Startup failed: ${e.message}`);
          });
        });

        connection.on('disconnected', () => {
          if (stopping) {
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
            digital_switching: {
              type: 'boolean',
              title: 'Allow crew to operate digital switching by message ("turn decklight on")',
              default: false,
            },
            populate_vessels: {
              type: 'boolean',
              title: 'Show position-sharing MeshCore nodes in Signal K (Freeboard etc)',
              default: false,
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
